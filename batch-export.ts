/**
 * batch-export.ts
 *
 * Fusion Automation worker for BetterExport.
 *
 * This script is executed by the Fusion Automation engine through:
 *
 *     AppBundle
 *          ↓
 *     BatchExportActivity
 *          ↓
 *     WorkItem
 *
 * The WorkItem supplies TaskParameters as JSON:
 *
 * {
 *   "hubId": "...",
 *   "fileURN": "..."
 * }
 *
 * The assembly/design must already exist in the user's Fusion Team hub.
 *
 * This script:
 *
 * 1. Reads TaskParameters from adsk.parameters
 * 2. Sets the appropriate Fusion Team hub
 * 3. Finds the requested Fusion file by URN
 * 4. Opens the design
 * 5. Finds the components/bodies to export
 * 6. Exports each component as STEP
 * 7. Optionally exports the full assembly as STEP
 * 8. Reports the generated file paths through adsk.result
 *
 * IMPORTANT:
 *
 * The generated STEP files currently exist only in the Automation
 * worker's local working directory. adsk.result reports their paths,
 * but does NOT itself upload the files to the user or website.
 *
 * Output delivery needs to be implemented separately.
 */

import { adsk } from "@adsk/fas";
import { readFileSync, writeFileSync } from "fs";


// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface TaskParameters {
  /**
   * If true, use the document currently open in Fusion.
   */
  useCurrentDocument?: boolean;

  /**
   * Input source for Design Automation runs.
   *
   * - "oss": import a file downloaded from OSS (InputFile activity param)
   * - omitted / other: open a Fusion Team hub file via hubId + fileURN
   */
  inputSource?: "oss";

  /**
   * Format of the OSS input file at inputLocalName.
   */
  inputFormat?: "f3d" | "step";

  /**
   * Worker-local path where the InputFile activity parameter is saved.
   */
  inputLocalName?: string;

  /**
   * Fusion Team hub ID.
   */
  hubId?: string;

  /**
   * Fusion Data Management file URN.
   */
  fileURN?: string;

  /**
   * Optional hierarchy information.
   */
  hierarchy?: {
    hubName: string;
    projectName: string;
    componentName: string;
    accessToken: string;
  };
}


interface ExportUnit {
  label: string;
  component: adsk.fusion.Component;
  sourceKind:
    | "occurrence"
    | "root"
    | "split-body"
    | "multi-body";
}


interface ComponentEntry {
  componentName: string;
  outputFile: string;
  source: string;
}


// -----------------------------------------------------------------------------
// Task parameter parsing
// -----------------------------------------------------------------------------

/**
 * Fusion Automation passes TaskParameters through adsk.parameters.
 * Depending on the activity/runtime this may already be a JSON string or
 * an object, so normalize before use.
 */
function parseTaskParameters(
  raw: unknown
): TaskParameters {
  if (raw == null || raw === "") {
    return {};
  }

  if (typeof raw === "string") {
    return JSON.parse(raw || "{}") as TaskParameters;
  }

  if (typeof raw === "object") {
    return raw as TaskParameters;
  }

  throw new Error(
    `Unexpected TaskParameters type: ${typeof raw}`
  );
}


// -----------------------------------------------------------------------------
// Utility functions
// -----------------------------------------------------------------------------

/**
 * Converts a Fusion component/body name into a safe filename.
 */
function sanitizeName(
  name: string | null | undefined
): string {
  const text = (name ?? "component")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_");

  const trimmed = text.replace(
    /^[._-]+|[._-]+$/g,
    ""
  );

  return trimmed || "component";
}


/**
 * Builds a unique STEP output path within the output directory.
 */
function uniqueOutputPath(
  outputDir: string,
  label: string,
  usedNames: Set<string>
): string {
  const base = sanitizeName(label);
  let candidate = base;
  let index = 2;

  while (usedNames.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }

  usedNames.add(candidate);

  return `${outputDir}/${candidate}.step`;
}


/**
 * Returns the number of bodies directly owned by a component.
 */
function componentOwnBodyCount(
  component: adsk.fusion.Component
): number {
  try {
    return component.bRepBodies.count;
  } catch {
    return 0;
  }
}


/**
 * Iterates through the child occurrences/components of a component.
 */
function* iterChildComponents(
  component: adsk.fusion.Component
): Generator<adsk.fusion.Component> {

  let occurrenceCount = 0;

  try {
    occurrenceCount = component.occurrences.count;
  } catch {
    occurrenceCount = 0;
  }

  for (let i = 0; i < occurrenceCount; i++) {
    try {
      const occurrence = component.occurrences.item(i);

      if (occurrence?.component) {
        yield occurrence.component;
      }
    } catch {
      continue;
    }
  }
}


// -----------------------------------------------------------------------------
// Multi-body component handling
// -----------------------------------------------------------------------------

/**
 * Returns true when the design is in direct modeling mode (e.g. after
 * STEP import). cutPasteBodies only works in parametric mode.
 */
function isDirectDesign(
  design: adsk.fusion.Design | null
): boolean {
  if (!design) {
    return false;
  }

  try {
    return (
      design.designType ===
      adsk.fusion.DesignTypes.DirectDesignType
    );
  } catch {
    return false;
  }
}


/**
 * Moves or copies one body into a new component for export.
 */
function placeBodyInComponent(
  design: adsk.fusion.Design | null,
  body: adsk.fusion.BRepBody,
  newComponent: adsk.fusion.Component
): void {
  if (isDirectDesign(design)) {
    const tmpMgr =
      adsk.fusion.TemporaryBRepManager.get();

    const clone =
      tmpMgr.copy(body);

    newComponent.bRepBodies.add(clone);

    return;
  }

  newComponent.features
    .cutPasteBodies
    .add(body);
}


/**
 * Splits a multi-body component into separate temporary components.
 * Each body becomes its own export unit.
 */
function splitComponentBodiesIntoUnits(
  component: adsk.fusion.Component,
  labelPrefix: string
): ExportUnit[] {

  const units: ExportUnit[] = [];

  let bodyCount = 0;

  try {
    bodyCount = component.bRepBodies.count;
  } catch {
    return units;
  }

  if (bodyCount <= 1) {
    return units;
  }

  const parentDesign = component.parentDesign;

  const rootComponent =
    parentDesign
      ? parentDesign.rootComponent
      : component;

  const useDirectSplit =
    isDirectDesign(parentDesign);

  if (useDirectSplit) {
    adsk.log(
      `Direct modeling design detected — copying bodies ` +
      `for "${labelPrefix}" instead of cut/paste.`
    );
  }

  // Snapshot body refs before splitting. Parametric cut/paste removes
  // each body from the source, so indexed access would shift afterward.
  const bodies: adsk.fusion.BRepBody[] = [];

  for (let i = 0; i < bodyCount; i++) {
    bodies.push(
      component.bRepBodies.item(i)
    );
  }

  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];

    const bodyName =
      body.name ||
      `body_${i + 1}`;

    try {
      const matrix =
        adsk.core.Matrix3D.create();

      const occurrence =
        rootComponent.occurrences
          .addNewComponent(matrix);

      const newComponent =
        occurrence.component;

      newComponent.name =
        `${labelPrefix}_${sanitizeName(bodyName)}`;

      placeBodyInComponent(
        parentDesign,
        body,
        newComponent
      );

      units.push({
        label: newComponent.name,
        component: newComponent,
        sourceKind: "split-body",
      });

    } catch (err) {
      adsk.log(
        `Could not split body "${bodyName}" ` +
        `out of "${labelPrefix}": ${err}`
      );
    }
  }

  adsk.log(
    `Component "${labelPrefix}": split ` +
    `${units.length} body/bodies for export.`
  );

  return units;
}


// -----------------------------------------------------------------------------
// Component discovery
// -----------------------------------------------------------------------------

/**
 * Walks the Fusion component hierarchy and determines which
 * components should be exported.
 *
 * A component with:
 *
 *   1 body  -> export as one STEP
 *
 *   >1 body -> split into individual export units
 *
 * Components are deduplicated using their entity token.
 */
function discoverExportUnits(
  rootComponent: adsk.fusion.Component | null,
  hierarchyNames: Set<string> | null = null
): ExportUnit[] {

  if (!rootComponent) {
    return [];
  }

  const visited =
    new Set<string>();

  const units: ExportUnit[] = [];


  function walk(
    component: adsk.fusion.Component | null
  ): void {

    if (!component) {
      return;
    }

    const token =
      component.entityToken ??
      String(component);

    if (visited.has(token)) {
      return;
    }

    visited.add(token);


    const name =
      component.name;

    const nameMatches =
      !hierarchyNames ||
      (
        name != null &&
        hierarchyNames.has(name)
      );


    const bodyCount =
      componentOwnBodyCount(component);


    // ---------------------------------------------------------
    // Single-body component
    // ---------------------------------------------------------

    if (
      bodyCount === 1 &&
      nameMatches
    ) {

      units.push({
        label: name || "component",
        component,
        sourceKind: "occurrence",
      });

    }


    // ---------------------------------------------------------
    // Multi-body component
    // ---------------------------------------------------------

    else if (
      bodyCount > 1 &&
      nameMatches
    ) {
      // Defer body splitting until export time so the design stays
      // intact for the full-assembly STEP export.
      units.push({
        label: name || "component",
        component,
        sourceKind: "multi-body",
      });
    }


    // ---------------------------------------------------------
    // Recurse into children
    // ---------------------------------------------------------

    for (
      const child of iterChildComponents(component)
    ) {
      walk(child);
    }
  }


  walk(rootComponent);


  // If a hierarchy filter was provided but matched nothing,
  // fall back to exporting without the filter.
  if (
    units.length === 0 &&
    hierarchyNames
  ) {

    return discoverExportUnits(
      rootComponent,
      null
    );
  }


  // If absolutely nothing was discovered,
  // fall back to the root component.
  if (
    units.length === 0 &&
    rootComponent
  ) {

    units.push({
      label:
        rootComponent.name ||
        "component",

      component:
        rootComponent,

      sourceKind:
        "root",
    });
  }


  return units;
}


// -----------------------------------------------------------------------------
// STEP export
// -----------------------------------------------------------------------------

/**
 * Exports one component as a STEP file.
 */
function exportComponentToStep(
  design: adsk.fusion.Design,
  outputPath: string,
  unit: ExportUnit
): void {
  adsk.log(
    `Exporting "${unit.label}" to ${outputPath}`
  );

  const options =
    design.exportManager
      .createSTEPExportOptions(
        outputPath,
        unit.component
      );

  const success =
    design.exportManager
      .execute(options);

  if (!success) {
    throw new Error(
      `Fusion reported that the export ` +
      `did not complete for "${unit.label}"`
    );
  }

  adsk.log(
    `Successfully exported "${unit.label}"`
  );
}


/**
 * Exports all discovered components as STEP files.
 */
function exportUnitsToStep(
  design: adsk.fusion.Design,
  outputDir: string,
  units: ExportUnit[]
): {
  outputFiles: string[];
  componentEntries: ComponentEntry[];
} {

  const outputFiles: string[] = [];

  const componentEntries: ComponentEntry[] = [];

  const usedNames = new Set<string>();


  for (const unit of units) {
    if (unit.sourceKind === "multi-body") {
      const splitUnits =
        splitComponentBodiesIntoUnits(
          unit.component,
          sanitizeName(unit.label)
        );

      if (splitUnits.length > 0) {
        for (const splitUnit of splitUnits) {
          const outputPath =
            uniqueOutputPath(
              outputDir,
              splitUnit.label,
              usedNames
            );

          exportComponentToStep(
            design,
            outputPath,
            splitUnit
          );

          outputFiles.push(outputPath);

          componentEntries.push({
            componentName: splitUnit.label,
            outputFile: outputPath,
            source: splitUnit.sourceKind,
          });
        }

        continue;
      }
    }

    const outputPath =
      uniqueOutputPath(
        outputDir,
        unit.label,
        usedNames
      );

    exportComponentToStep(
      design,
      outputPath,
      unit
    );

    outputFiles.push(outputPath);

    componentEntries.push({
      componentName: unit.label,
      outputFile: outputPath,
      source: unit.sourceKind,
    });
  }


  return {
    outputFiles,
    componentEntries,
  };
}


/**
 * Exports the entire assembly as one STEP file.
 */
function exportFullAssemblyToStep(
  design: adsk.fusion.Design,
  outputDir: string,
  label: string,
  usedNames: Set<string>
): string {

  const outputPath =
    uniqueOutputPath(
      outputDir,
      label,
      usedNames
    );


  adsk.log(
    `Exporting full assembly to ${outputPath}`
  );


  const options =
    design.exportManager
      .createSTEPExportOptions(
        outputPath
      );


  const success =
    design.exportManager
      .execute(options);


  if (!success) {

    throw new Error(
      "Fusion reported that the full-assembly " +
      "export did not complete"
    );
  }


  return outputPath;
}


/**
 * Writes a minimal ZIP archive using the STORE method.
 *
 * Fusion Automation does not provide a zip library, but the worker can read
 * and write local files. This is enough to package STEP exports for the
 * activity OutputZip parameter.
 */
function writeZipArchive(
  zipPath: string,
  files: string[]
): void {
  const chunks: number[] = [];
  const centralDirectory: number[] = [];
  let offset = 0;

  function writeUint16(
    target: number[],
    value: number
  ): void {
    target.push(value & 0xff, (value >> 8) & 0xff);
  }

  function writeUint32(
    target: number[],
    value: number
  ): void {
    target.push(
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >> 24) & 0xff
    );
  }

  function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;

    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];

      for (let bit = 0; bit < 8; bit++) {
        const mask = -(crc & 1);
        crc = (crc >>> 1) ^ (0xedb88320 & mask);
      }
    }

    return (crc ^ 0xffffffff) >>> 0;
  }

  for (const filePath of files) {
    const fileName =
      filePath.split("/").pop() ||
      filePath.split("\\").pop() ||
      filePath;

    const fileBytes = new Uint8Array(
      readFileSync(filePath)
    );

    const localHeaderStart = offset;
    const fileCrc = crc32(fileBytes);

    writeUint32(chunks, 0x04034b50);
    writeUint16(chunks, 20);
    writeUint16(chunks, 0);
    writeUint16(chunks, 0);
    writeUint16(chunks, 0);
    writeUint16(chunks, 0);
    writeUint32(chunks, fileCrc);
    writeUint32(chunks, fileBytes.length);
    writeUint32(chunks, fileBytes.length);
    writeUint16(chunks, fileName.length);
    writeUint16(chunks, 0);

    for (let i = 0; i < fileName.length; i++) {
      chunks.push(fileName.charCodeAt(i));
    }

    for (let i = 0; i < fileBytes.length; i++) {
      chunks.push(fileBytes[i]);
    }

    offset = chunks.length;

    const centralHeaderStart = centralDirectory.length;

    writeUint32(centralDirectory, 0x02014b50);
    writeUint16(centralDirectory, 20);
    writeUint16(centralDirectory, 20);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint32(centralDirectory, fileCrc);
    writeUint32(centralDirectory, fileBytes.length);
    writeUint32(centralDirectory, fileBytes.length);
    writeUint16(centralDirectory, fileName.length);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint16(centralDirectory, 0);
    writeUint32(centralDirectory, 0);
    writeUint32(centralDirectory, localHeaderStart);

    for (let i = 0; i < fileName.length; i++) {
      centralDirectory.push(fileName.charCodeAt(i));
    }

    void centralHeaderStart;
  }

  const centralDirectoryStart = chunks.length;
  chunks.push(...centralDirectory);

  writeUint32(chunks, 0x06054b50);
  writeUint16(chunks, 0);
  writeUint16(chunks, 0);
  writeUint16(chunks, files.length);
  writeUint16(chunks, files.length);
  writeUint32(chunks, centralDirectory.length);
  writeUint32(chunks, centralDirectoryStart);
  writeUint16(chunks, 0);

  const zipBytes = new Uint8Array(chunks);
  writeFileSync(zipPath, zipBytes);
}


// -----------------------------------------------------------------------------
// Fusion document resolution
// -----------------------------------------------------------------------------

/**
 * Resolves the Fusion Document specified by TaskParameters.
 *
 * Modes:
 *
 * 1. useCurrentDocument = true
 *      Use the currently open Fusion document.
 *
 * 2. inputSource = "oss"
 *      Import the OSS input file from the worker directory.
 *
 * 3. hubId + fileURN
 *      Open a Fusion Team hub file.
 */
function getDocument(
  app: adsk.core.Application,
  taskParameters: TaskParameters
): adsk.core.Document {

  const useCurrentDocument =
    taskParameters.useCurrentDocument === true;


  // ---------------------------------------------------------
  // Current document mode
  // ---------------------------------------------------------

  if (useCurrentDocument) {

    adsk.log(
      `Using currently open document: ` +
      `${app.activeDocument.name}.`
    );

    return app.activeDocument;
  }


  // ---------------------------------------------------------
  // OSS input mode
  // ---------------------------------------------------------

  if (taskParameters.inputSource === "oss") {
    return importDocumentFromOss(
      app,
      taskParameters.inputLocalName ?? "input.stp",
      taskParameters.inputFormat ?? "f3d"
    );
  }


  // ---------------------------------------------------------
  // Fusion Team hub mode
  // ---------------------------------------------------------

  const hubId = taskParameters.hubId;
  const fileURN = taskParameters.fileURN;

  if (!fileURN) {

    throw new Error(
      "fileURN is required when opening a Fusion Team file."
    );
  }


  if (!hubId) {

    throw new Error(
      "hubId is required when opening a Fusion Team file."
    );
  }


  // ---------------------------------------------------------
  // Set active Fusion Team hub
  // ---------------------------------------------------------

  {

    const hub =
      app.data.dataHubs.itemById(hubId) ||

      app.data.dataHubs.itemById(
        `a.${adsk.btoa(
          `business:${hubId}`,
          true
        )}`
      ) ||

      app.data.dataHubs.itemById(
        `a.${adsk.btoa(
          `personal:${hubId}`,
          true
        )}`
      );


    if (!hub) {

      throw new Error(
        `Hub with id ${hubId} not found.`
      );
    }


    adsk.log(
      `Setting hub: ${hub.name}.`
    );


    app.data.activeHub =
      hub;
  }


  // ---------------------------------------------------------
  // Find Fusion file
  // ---------------------------------------------------------

  const file =
    app.data.findFileById(
      fileURN
    );


  if (!file) {

    throw new Error(
      `File not found: ${fileURN}.`
    );
  }


  adsk.log(
    `Opening ${file.name}`
  );


  // ---------------------------------------------------------
  // Open document
  // ---------------------------------------------------------

  const document =
    app.documents.open(
      file,
      true
    );


  if (!document) {

    throw new Error(
      `Cannot open file ${file.name}.`
    );
  }


  return document;
}


/**
 * Imports a design file that was downloaded to the worker by the
 * InputF3d / InputStep activity parameter.
 */
function importDocumentFromOss(
  app: adsk.core.Application,
  inputLocalName: string,
  inputFormat: "f3d" | "step"
): adsk.core.Document {
  let importPath = inputLocalName;

  if (
    inputFormat === "step" &&
    !/\.(step|stp)$/i.test(importPath)
  ) {
    const stepPath = "input.stp";

    adsk.log(
      `Copying STEP input from ./${importPath} to ./${stepPath}`
    );

    writeFileSync(
      stepPath,
      readFileSync(importPath)
    );

    importPath = stepPath;
  }

  adsk.log(
    `Importing OSS ${inputFormat} input from ./${importPath}`
  );

  const importManager =
    app.importManager;

  const importOptions =
    inputFormat === "step"
      ? importManager.createSTEPImportOptions(
          importPath
        )
      : importManager.createFusionArchiveImportOptions(
          importPath
        );

  const document =
    importManager.importToNewDocument(
      importOptions
    );

  if (!document) {
    throw new Error(
      `Failed to import ${inputFormat} file ` +
      `"${importPath}".`
    );
  }

  adsk.log(
    `Imported document: ${document.name}`
  );

  return document;
}


// -----------------------------------------------------------------------------
// Event processing
// -----------------------------------------------------------------------------

/**
 * Allows Fusion to continue processing asynchronous/internal jobs.
 */
function wait(ms: number): void {

  const start =
    new Date().getTime();


  while (
    new Date().getTime() -
    start <
    ms
  ) {

    adsk.doEvents();
  }
}


// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

function run(): void {

  const app =
    adsk.core.Application.get();


  if (!app) {

    throw new Error(
      "No adsk.core.Application."
    );
  }


  try {

    // ---------------------------------------------------------
    // 1. Read WorkItem parameters
    // ---------------------------------------------------------

    const taskParameters =
      parseTaskParameters(
        adsk.parameters
      );


    adsk.log(
      `BetterExport started. ` +
      `TaskParameters: ` +
      `${JSON.stringify(taskParameters)}`
    );


    // ---------------------------------------------------------
    // 2. Open input Fusion document
    // ---------------------------------------------------------

    const doc =
      getDocument(
        app,
        taskParameters
      );


    // ---------------------------------------------------------
    // 4. Get Fusion Design
    // ---------------------------------------------------------

    const design =
      doc.products.itemByProductType(
        "DesignProductType"
      ) as adsk.fusion.Design;


    if (!design) {

      throw new Error(
        `No Design product found in the opened document.`
      );
    }


    const rootComponent =
      design.rootComponent;


    // ---------------------------------------------------------
    // 5. Automation working directory
    // ---------------------------------------------------------

    // Files generated here are local to the Automation
    // worker. They must later be connected to an Activity
    // output mechanism if you want them returned to your
    // backend.
    const outputDir = ".";


    // ---------------------------------------------------------
    // 6. Optional hierarchy filtering
    // ---------------------------------------------------------

    // The hierarchy lookup is not being used in the current
    // basic workflow.
    //
    // If you later restore the MDM GraphQL lookup, this can
    // become a Set<string> of component names.
    const hierarchyNames:
      Set<string> | null =
        null;


    // ---------------------------------------------------------
    // 7. Discover export targets
    // ---------------------------------------------------------

    const units =
      discoverExportUnits(
        rootComponent,
        hierarchyNames
      );

    adsk.log(
      `Discovered ${units.length} ` +
      `export unit(s): ` +
      `${units.map(
        (u) => u.label
      ).join(", ")}`
    );


    const usedOutputNames = new Set<string>();


    // ---------------------------------------------------------
    // 8. Export complete assembly before mutating the design
    // ---------------------------------------------------------

    let allOutputFiles: string[] = [];

    let allComponentEntries: ComponentEntry[] = [];


    const shouldExportFullAssembly =
      units.length > 1 ||
      units.some(
        (unit) =>
          unit.sourceKind === "multi-body" &&
          componentOwnBodyCount(unit.component) > 1
      );


    if (shouldExportFullAssembly) {

      const assemblyLabel =
        `${sanitizeName(
          rootComponent?.name ||
          "design"
        )}_assembly`;


      const assemblyFile =
        exportFullAssemblyToStep(
          design,
          outputDir,
          assemblyLabel,
          usedOutputNames
        );


      allOutputFiles.push(assemblyFile);

      allComponentEntries.push({
        componentName: assemblyLabel,
        outputFile: assemblyFile,
        source: "full-assembly",
      });


      adsk.log(
        `Exported full assembly: ` +
        `${assemblyFile}`
      );
    }


    // ---------------------------------------------------------
    // 9. Export individual components / split multi-body parts
    // ---------------------------------------------------------

    const {
      outputFiles,
      componentEntries,
    } =
      exportUnitsToStep(
        design,
        outputDir,
        units
      );

    allOutputFiles = [
      ...allOutputFiles,
      ...outputFiles,
    ];

    allComponentEntries = [
      ...allComponentEntries,
      ...componentEntries,
    ];


    // ---------------------------------------------------------
    // 10. Report results
    // ---------------------------------------------------------

    adsk.log(
      `Export completed. ` +
      `${allOutputFiles.length} file(s) generated.`
    );


    let outputZip: string | null = null;

    if (allOutputFiles.length > 0) {
      outputZip = "exports.zip";

      adsk.log(
        `Packaging ${allOutputFiles.length} file(s) into ${outputZip}`
      );

      writeZipArchive(
        outputZip,
        allOutputFiles
      );
    }


    adsk.result =
      JSON.stringify({

        succeeded:
          true,

        input:
          taskParameters.inputSource === "oss"
            ? {
                inputSource: "oss",
                inputFormat:
                  taskParameters.inputFormat,
                inputLocalName:
                  taskParameters.inputLocalName,
              }
            : {
                hubId:
                  taskParameters.hubId,
                fileURN:
                  taskParameters.fileURN,
              },

        outputFiles:
          allOutputFiles,

        outputZip,

        componentEntries:
          allComponentEntries,
      });


    // ---------------------------------------------------------
    // 11. Wait for remaining Fusion jobs
    // ---------------------------------------------------------

    while (
      app.hasActiveJobs
    ) {

      wait(2000);
    }


    if (taskParameters.useCurrentDocument !== true) {
      doc.close(false);
    }


    adsk.log(
      "BetterExport completed successfully."
    );


  } catch (err) {

    // ---------------------------------------------------------
    // Error handling
    // ---------------------------------------------------------

    const errorMessage =
      String(err);


    adsk.log(
      `BetterExport failed: ` +
      `${errorMessage}`
    );


    adsk.result =
      JSON.stringify({

        succeeded:
          false,

        error:
          errorMessage,
      });
  }
}


// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

run();
