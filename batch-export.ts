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
    | "multi-body"
    | "flat-body"
    | "global-part"
    | "sub-assembly"
    | "part"
    | "body";
  fingerprint?: string;
  instanceCount?: number;
  matchedBodyNames?: string[];
}


interface SubAssemblyExportPlan {
  component: adsk.fusion.Component;
  label: string;
  location: string;
  skippedLocations: string[];
}


interface PartExportPlan {
  component: adsk.fusion.Component;
  label: string;
  location: string;
  bodyCount: number;
  skippedLocations: string[];
}


interface ComponentEntry {
  componentName: string;
  outputFile: string;
  source: string;
  fingerprint?: string;
  instanceCount?: number;
  matchedBodyNames?: string[];
}


interface AssemblyBodyRef {
  component: adsk.fusion.Component;
  componentLabel: string;
  body: adsk.fusion.BRepBody;
  bodyName: string;
  bodyIndex: number;
  location: string;
}


interface GlobalBodyExportPlan {
  body: adsk.fusion.BRepBody;
  metrics: BodyMetrics;
  fingerprint: string;
  exportLabel: string;
  matchedInstances: Array<{
    componentLabel: string;
    bodyName: string;
    location: string;
  }>;
  instanceCount: number;
}


interface PartsManifestEntry {
  part: string;
  quantity: number;
  locations: string[];
  mirrors?: string[];
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
 * True when the component or body has a meaningful name from the source
 * file rather than a Fusion default placeholder.
 */
function isNamedInFile(
  name: string | null | undefined
): boolean {
  const trimmed = (name ?? "").trim();

  if (!trimmed) {
    return false;
  }

  const lower = trimmed.toLowerCase();

  if (
    lower === "component" ||
    lower === "body" ||
    lower === "design" ||
    lower === "untitled" ||
    lower === "root component"
  ) {
    return false;
  }

  if (/^component\s*\d*$/i.test(trimmed)) {
    return false;
  }

  if (/^body\s*\d*$/i.test(trimmed)) {
    return false;
  }

  return true;
}


function buildUnlabeledPartExportLabel(
  sequenceByUnlabeled: Map<string, number>
): string {
  const key = "__unlabeled__";
  const nextSequence =
    (sequenceByUnlabeled.get(key) ?? 0) + 1;

  sequenceByUnlabeled.set(key, nextSequence);

  return `part_${nextSequence}`;
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
 * Returns the number of child occurrences on a component.
 */
function componentOccurrenceCount(
  component: adsk.fusion.Component
): number {
  try {
    return component.occurrences.count;
  } catch {
    return 0;
  }
}


interface ReferencePoint {
  x: number;
  y: number;
  z: number;
  source: "center-of-mass" | "bbox-center";
}


interface FaceLayoutEntry {
  area: number;
  distanceFromCom: number;
}


interface InertiaTensorAtCom {
  ixx: number;
  iyy: number;
  izz: number;
  ixy: number;
  iyz: number;
  ixz: number;
}


/**
 * Minimal geometry metrics for duplicate and mirror detection.
 */
interface BodyMetrics {
  volume: number;
  area: number;
  referencePoint: ReferencePoint;
  /** Sorted by area then distance — invariant under rotation. */
  faceLayout: FaceLayoutEntry[];
  /** Sorted principal moments (kg·cm²) — no chirality alone. */
  principalMoments: [number, number, number];
  /** Mass from physical properties (kg). */
  mass: number;
  /** Full inertia tensor at COM in the body/component frame. */
  inertiaAtCom: InertiaTensorAtCom;
  /** sign(Ixy)·sign(Iyz)·sign(Ixz) at COM in the shared frame. */
  inertiaProductParity: number;
  /**
   * Triple product of principal axes after pinning each axis toward the
   * largest face centroid from COM.
   */
  pinnedAxisHandedness: number;
  /** Mass and principal moments were read successfully from the API. */
  inertiaValid: boolean;
  /** Pinned axis handedness is usable for mirror vs rotation decisions. */
  inertiaReliable: boolean;
  /** Why inertia is or is not usable for chirality. */
  inertiaStatus: string;
}


interface BodyMaterialSnapshot {
  body: adsk.fusion.BRepBody;
  originalMaterial: adsk.core.Material | null;
}


const BULK_METRIC_REL_TOLERANCE = 1e-5;
const BULK_METRIC_ABS_TOLERANCE = 1e-7;
const LOCAL_METRIC_REL_TOLERANCE = 2e-4;
const LOCAL_METRIC_ABS_TOLERANCE = 1e-6;
const INERTIA_MIN_VALID_MASS = 1e-6;
const INERTIA_MIN_PRINCIPAL_MOMENT = 1e-9;
const INERTIA_MIN_AXIS_HANDEDNESS = 0.5;
const INERTIA_MIN_MOMENT_SPREAD = 0.01;


function metricsClose(
  left: number,
  right: number,
  relativeTolerance = BULK_METRIC_REL_TOLERANCE,
  absoluteTolerance = BULK_METRIC_ABS_TOLERANCE
): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return left === right;
  }

  const delta = Math.abs(left - right);

  if (delta <= absoluteTolerance) {
    return true;
  }

  const scale = Math.max(
    Math.abs(left),
    Math.abs(right),
    absoluteTolerance
  );

  return delta / scale <= relativeTolerance;
}


function sortedNumbersClose(
  left: number[],
  right: number[],
  relativeTolerance = LOCAL_METRIC_REL_TOLERANCE,
  absoluteTolerance = LOCAL_METRIC_ABS_TOLERANCE
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let i = 0; i < left.length; i++) {
    if (
      !metricsClose(
        left[i],
        right[i],
        relativeTolerance,
        absoluteTolerance
      )
    ) {
      return false;
    }
  }

  return true;
}


function collectBboxCenter(
  body: adsk.fusion.BRepBody
): ReferencePoint {
  try {
    const bbox = body.boundingBox;

    return {
      x:
        (bbox.minPoint.x + bbox.maxPoint.x) /
        2,
      y:
        (bbox.minPoint.y + bbox.maxPoint.y) /
        2,
      z:
        (bbox.minPoint.z + bbox.maxPoint.z) /
        2,
      source: "bbox-center",
    };
  } catch {
    return {
      x: 0,
      y: 0,
      z: 0,
      source: "bbox-center",
    };
  }
}


function collectFaceLayout(
  body: adsk.fusion.BRepBody,
  referencePoint: ReferencePoint
): FaceLayoutEntry[] {
  const layout: FaceLayoutEntry[] = [];

  try {
    const faceCount = body.faces.count;

    for (let i = 0; i < faceCount; i++) {
      const face = body.faces.item(i);
      const centroid = face.centroid;
      const dx = centroid.x - referencePoint.x;
      const dy = centroid.y - referencePoint.y;
      const dz = centroid.z - referencePoint.z;
      const distance = Math.sqrt(
        dx * dx + dy * dy + dz * dz
      );

      layout.push({
        area: face.area,
        distanceFromCom: distance,
      });
    }
  } catch {
    return layout;
  }

  layout.sort((left, right) => {
    if (left.area !== right.area) {
      return left.area - right.area;
    }

    return (
      left.distanceFromCom - right.distanceFromCom
    );
  });

  return layout;
}


function faceLayoutMatch(
  left: FaceLayoutEntry[],
  right: FaceLayoutEntry[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const leftAreas = left
    .map((face) => face.area)
    .sort((a, b) => a - b);
  const rightAreas = right
    .map((face) => face.area)
    .sort((a, b) => a - b);

  if (
    !sortedNumbersClose(
      leftAreas,
      rightAreas
    )
  ) {
    return false;
  }

  const leftDistances = left
    .map((face) => face.distanceFromCom)
    .sort((a, b) => a - b);
  const rightDistances = right
    .map((face) => face.distanceFromCom)
    .sort((a, b) => a - b);

  return sortedNumbersClose(
    leftDistances,
    rightDistances
  );
}


interface Vector3 {
  x: number;
  y: number;
  z: number;
}


function vectorFromPoint3D(
  point: adsk.core.Point3D | Vector3
): Vector3 {
  return {
    x: point.x,
    y: point.y,
    z: point.z,
  };
}


function dotProduct(
  left: Vector3,
  right: Vector3
): number {
  return (
    left.x * right.x +
    left.y * right.y +
    left.z * right.z
  );
}


function negateVector(
  vector: Vector3
): Vector3 {
  return {
    x: -vector.x,
    y: -vector.y,
    z: -vector.z,
  };
}


function vectorLength(
  vector: Vector3
): number {
  return Math.sqrt(dotProduct(vector, vector));
}


function normalizeVector(
  vector: Vector3
): Vector3 | null {
  const length = vectorLength(vector);

  if (length <= BULK_METRIC_ABS_TOLERANCE) {
    return null;
  }

  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}


function asVector3(
  value: unknown
): Vector3 | null {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    if (value.length < 3) {
      return null;
    }

    return {
      x: Number(value[0]),
      y: Number(value[1]),
      z: Number(value[2]),
    };
  }

  if (
    typeof value === "object" &&
    "x" in value &&
    "y" in value &&
    "z" in value
  ) {
    return vectorFromPoint3D(
      value as adsk.core.Vector3D
    );
  }

  return null;
}


function scalarTripleProduct(
  first: Vector3,
  second: Vector3,
  third: Vector3
): number {
  return (
    first.x *
      (second.y * third.z - second.z * third.y) +
    first.y *
      (second.z * third.x - second.x * third.z) +
    first.z *
      (second.x * third.y - second.y * third.x)
  );
}


function findTemporarySteelMaterial(
  app: adsk.core.Application
): adsk.core.Material | null {
  const libraryNames = [
    "Fusion Material Library",
    "Fusion 360 Material Library",
  ];
  const preferredMaterialNames = [
    "Steel",
    "Steel, Carbon",
    "Steel, Mild",
    "Stainless Steel",
  ];

  try {
    const libraries = app.materialLibraries;

    for (const libraryName of libraryNames) {
      const library =
        libraries.itemByName(libraryName);

      if (!library) {
        continue;
      }

      for (const materialName of preferredMaterialNames) {
        const material =
          library.materials.itemByName(
            materialName
          );

        if (material) {
          return material;
        }
      }

      for (
        let index = 0;
        index < library.materials.count;
        index++
      ) {
        const material =
          library.materials.item(index);

        if (
          material.name
            .toLowerCase()
            .includes("steel")
        ) {
          return material;
        }
      }
    }
  } catch (err) {
    adsk.log(
      `Could not search material libraries for steel: ${err}`
    );
  }

  return null;
}


function applyTemporarySteelMaterials(
  bodyRefs: AssemblyBodyRef[],
  steel: adsk.core.Material
): BodyMaterialSnapshot[] {
  const snapshots: BodyMaterialSnapshot[] = [];
  const visited = new Set<string>();

  for (const ref of bodyRefs) {
    const token =
      ref.body.entityToken ??
      ref.location;

    if (visited.has(token)) {
      continue;
    }

    visited.add(token);

    let originalMaterial:
      adsk.core.Material | null = null;

    try {
      originalMaterial =
        ref.body.material ?? null;
    } catch {
      originalMaterial = null;
    }

    try {
      ref.body.material = steel;
    } catch (err) {
      adsk.log(
        `Could not apply temporary steel material ` +
        `to "${ref.location}": ${err}`
      );
    }

    snapshots.push({
      body: ref.body,
      originalMaterial,
    });
  }

  return snapshots;
}


function restoreBodyMaterials(
  snapshots: BodyMaterialSnapshot[]
): void {
  for (const snapshot of snapshots) {
    try {
      snapshot.body.material =
        snapshot.originalMaterial ??
        snapshot.body.material;
    } catch (err) {
      adsk.log(
        `Could not restore original material: ${err}`
      );
    }
  }
}


function readXYZMomentsOfInertia(
  props: adsk.fusion.PhysicalProperties
): {
  tensor: InertiaTensorAtCom;
  succeeded: boolean;
} {
  const emptyTensor: InertiaTensorAtCom = {
    ixx: 0,
    iyy: 0,
    izz: 0,
    ixy: 0,
    iyz: 0,
    ixz: 0,
  };

  const values =
    props.getXYZMomentsOfInertia() as unknown;

  if (!Array.isArray(values) || values.length < 6) {
    return {
      tensor: emptyTensor,
      succeeded: false,
    };
  }

  let offset = 0;

  if (
    typeof values[0] === "boolean" ||
    values.length >= 7
  ) {
    if (values[0] === false) {
      return {
        tensor: emptyTensor,
        succeeded: false,
      };
    }

    offset = 1;
  }

  if (values.length - offset < 6) {
    return {
      tensor: emptyTensor,
      succeeded: false,
    };
  }

  const tensor = {
    ixx: Number(values[offset]),
    iyy: Number(values[offset + 1]),
    izz: Number(values[offset + 2]),
    ixy: Number(values[offset + 3]),
    iyz: Number(values[offset + 4]),
    ixz: Number(values[offset + 5]),
  };

  if (
    ![
      tensor.ixx,
      tensor.iyy,
      tensor.izz,
      tensor.ixy,
      tensor.iyz,
      tensor.ixz,
    ].every(Number.isFinite)
  ) {
    return {
      tensor: emptyTensor,
      succeeded: false,
    };
  }

  return {
    tensor,
    succeeded: true,
  };
}


function shiftInertiaTensorToCom(
  tensor: InertiaTensorAtCom,
  com: Vector3,
  mass: number
): InertiaTensorAtCom {
  const dx = com.x;
  const dy = com.y;
  const dz = com.z;

  return {
    ixx:
      tensor.ixx -
      mass * (dy * dy + dz * dz),
    iyy:
      tensor.iyy -
      mass * (dx * dx + dz * dz),
    izz:
      tensor.izz -
      mass * (dx * dx + dy * dy),
    ixy: tensor.ixy + mass * dx * dy,
    iyz: tensor.iyz + mass * dy * dz,
    ixz: tensor.ixz + mass * dx * dz,
  };
}


function inertiaProductParity(
  tensor: InertiaTensorAtCom
): number {
  const signs = [
    Math.sign(tensor.ixy),
    Math.sign(tensor.iyz),
    Math.sign(tensor.ixz),
  ].filter((sign) => sign !== 0);

  if (signs.length === 0) {
    return 0;
  }

  return signs.reduce(
    (product, sign) => product * sign,
    1
  );
}


function readPrincipalAxes(
  props: adsk.fusion.PhysicalProperties
): [Vector3, Vector3, Vector3] | null {
  const values =
    props.getPrincipalAxes() as unknown;

  let axisValues: unknown[] | null = null;

  if (Array.isArray(values)) {
    if (values.length >= 4) {
      if (
        values[0] === false ||
        values[0] === 0
      ) {
        return null;
      }

      if (
        typeof values[0] === "boolean" ||
        values[0] === 1
      ) {
        axisValues = values.slice(1, 4);
      } else {
        axisValues = values.slice(0, 3);
      }
    } else if (values.length >= 3) {
      axisValues = values.slice(0, 3);
    }
  } else if (
    values &&
    typeof values === "object"
  ) {
    const record = values as Record<
      string,
      unknown
    >;

    if (
      record.xAxis &&
      record.yAxis &&
      record.zAxis
    ) {
      axisValues = [
        record.xAxis,
        record.yAxis,
        record.zAxis,
      ];
    }
  }

  if (!axisValues || axisValues.length < 3) {
    return null;
  }

  const rawAxes = axisValues
    .map((value) => asVector3(value))
    .filter(
      (axis): axis is Vector3 => axis !== null
    );

  if (rawAxes.length < 3) {
    return null;
  }

  const axes = rawAxes
    .map((axis) => normalizeVector(axis))
    .filter(
      (axis): axis is Vector3 => axis !== null
    );

  if (axes.length < 3) {
    return null;
  }

  return axes as [Vector3, Vector3, Vector3];
}


function largestFaceFeatureVector(
  body: adsk.fusion.BRepBody,
  com: Vector3
): Vector3 | null {
  let bestArea = 0;
  let bestVector: Vector3 | null = null;

  try {
    const faceCount = body.faces.count;

    for (let i = 0; i < faceCount; i++) {
      const face = body.faces.item(i);
      const centroid = face.centroid;
      const vector = {
        x: centroid.x - com.x,
        y: centroid.y - com.y,
        z: centroid.z - com.z,
      };
      const length = vectorLength(vector);

      if (
        face.area > bestArea &&
        length > BULK_METRIC_ABS_TOLERANCE
      ) {
        bestArea = face.area;
        bestVector = vector;
      }
    }
  } catch {
    return null;
  }

  return bestVector;
}


function pinPrincipalAxis(
  axis: Vector3,
  feature: Vector3
): Vector3 {
  if (dotProduct(axis, feature) < 0) {
    return negateVector(axis);
  }

  return axis;
}


function computePinnedAxisHandedness(
  body: adsk.fusion.BRepBody,
  props: adsk.fusion.PhysicalProperties,
  com: Vector3
): number {
  const axes = readPrincipalAxes(props);
  const feature =
    largestFaceFeatureVector(body, com);

  if (!axes || !feature) {
    return 0;
  }

  const pinnedAxes = axes.map((axis) => {
    const pinned = pinPrincipalAxis(axis, feature);
    return normalizeVector(pinned);
  });

  if (pinnedAxes.some((axis) => !axis)) {
    return 0;
  }

  return scalarTripleProduct(
    pinnedAxes[0] as Vector3,
    pinnedAxes[1] as Vector3,
    pinnedAxes[2] as Vector3
  );
}


function readPrincipalMomentsOfInertia(
  props: adsk.fusion.PhysicalProperties
): {
  moments: [number, number, number];
  succeeded: boolean;
} {
  const values =
    props.getPrincipalMomentsOfInertia() as unknown;

  if (!Array.isArray(values) || values.length < 3) {
    return {
      moments: [0, 0, 0],
      succeeded: false,
    };
  }

  let rawMoments: number[] = [];

  if (
    values.length >= 4 &&
    (typeof values[0] === "boolean" ||
      values[0] === 0 ||
      values[0] === 1)
  ) {
    if (values[0] === false || values[0] === 0) {
      return {
        moments: [0, 0, 0],
        succeeded: false,
      };
    }

    rawMoments = [
      Number(values[1]),
      Number(values[2]),
      Number(values[3]),
    ];
  } else {
    rawMoments = values
      .slice(0, 3)
      .map((value) => Number(value));
  }

  if (
    rawMoments.length < 3 ||
    !rawMoments.every(Number.isFinite)
  ) {
    return {
      moments: [0, 0, 0],
      succeeded: false,
    };
  }

  return {
    moments: [
      rawMoments[0],
      rawMoments[1],
      rawMoments[2],
    ].sort(
      (left, right) => left - right
    ) as [number, number, number],
    succeeded: true,
  };
}


function principalMomentsAreDistinct(
  principalMoments: [number, number, number]
): boolean {
  const sorted = [...principalMoments].sort(
    (left, right) => left - right
  );
  const scale = Math.max(
    Math.abs(sorted[2]),
    INERTIA_MIN_PRINCIPAL_MOMENT
  );

  return (
    (sorted[2] - sorted[0]) / scale >=
    INERTIA_MIN_MOMENT_SPREAD
  );
}


function evaluateInertiaMetrics(
  mass: number,
  principalMoments: [number, number, number],
  principalMomentsRead: boolean,
  tensorRead: boolean,
  referenceSource: ReferencePoint["source"],
  pinnedAxisHandedness: number
): {
  inertiaValid: boolean;
  inertiaReliable: boolean;
  inertiaStatus: string;
} {
  if (referenceSource !== "center-of-mass") {
    return {
      inertiaValid: false,
      inertiaReliable: false,
      inertiaStatus: "bbox fallback (no COM inertia)",
    };
  }

  if (!principalMomentsRead || !tensorRead) {
    return {
      inertiaValid: false,
      inertiaReliable: false,
      inertiaStatus: "physical properties API read failed",
    };
  }

  if (
    !Number.isFinite(mass) ||
    mass <= INERTIA_MIN_VALID_MASS
  ) {
    return {
      inertiaValid: false,
      inertiaReliable: false,
      inertiaStatus: `mass too small (${formatMetric(mass)} kg)`,
    };
  }

  const momentSum = principalMoments.reduce(
    (total, moment) =>
      total + Math.abs(moment),
    0
  );

  if (
    !Number.isFinite(momentSum) ||
    momentSum <= INERTIA_MIN_PRINCIPAL_MOMENT
  ) {
    return {
      inertiaValid: false,
      inertiaReliable: false,
      inertiaStatus: "principal moments are zero",
    };
  }

  if (
    !principalMomentsAreDistinct(
      principalMoments
    )
  ) {
    return {
      inertiaValid: true,
      inertiaReliable: false,
      inertiaStatus:
        "principal moments too similar for axis handedness",
    };
  }

  if (
    !Number.isFinite(pinnedAxisHandedness) ||
    Math.abs(pinnedAxisHandedness) <
      INERTIA_MIN_AXIS_HANDEDNESS
  ) {
    return {
      inertiaValid: true,
      inertiaReliable: false,
      inertiaStatus:
        "principal axis handedness unavailable",
    };
  }

  return {
    inertiaValid: true,
    inertiaReliable: true,
    inertiaStatus: "ok",
  };
}


function collectPhysicalPropertiesMetrics(
  body: adsk.fusion.BRepBody
): Pick<
  BodyMetrics,
  | "referencePoint"
  | "principalMoments"
  | "mass"
  | "inertiaAtCom"
  | "inertiaProductParity"
  | "pinnedAxisHandedness"
  | "inertiaValid"
  | "inertiaReliable"
  | "inertiaStatus"
> {
  const emptyTensor: InertiaTensorAtCom = {
    ixx: 0,
    iyy: 0,
    izz: 0,
    ixy: 0,
    iyz: 0,
    ixz: 0,
  };

  const fallback = {
    referencePoint: collectBboxCenter(body),
    principalMoments: [0, 0, 0] as [
      number,
      number,
      number,
    ],
    mass: 0,
    inertiaAtCom: emptyTensor,
    inertiaProductParity: 0,
    pinnedAxisHandedness: 0,
    inertiaValid: false,
    inertiaReliable: false,
    inertiaStatus: "physical properties unavailable",
  };

  try {
    const props = body.getPhysicalProperties(
      adsk.fusion.CalculationAccuracy
        .HighCalculationAccuracy
    );

    const com = props.centerOfMass;
    const comVector = {
      x: com.x,
      y: com.y,
      z: com.z,
    };
    const {
      tensor: originTensor,
      succeeded: tensorRead,
    } = readXYZMomentsOfInertia(props);
    const {
      moments: principalMoments,
      succeeded: principalMomentsRead,
    } = readPrincipalMomentsOfInertia(props);
    const mass = props.mass;
    const inertiaAtCom =
      shiftInertiaTensorToCom(
        originTensor,
        comVector,
        mass
      );
    const pinnedAxisHandedness =
      computePinnedAxisHandedness(
        body,
        props,
        comVector
      );
    const inertiaEvaluation =
      evaluateInertiaMetrics(
        mass,
        principalMoments,
        principalMomentsRead,
        tensorRead,
        "center-of-mass",
        pinnedAxisHandedness
      );

    return {
      referencePoint: {
        x: com.x,
        y: com.y,
        z: com.z,
        source: "center-of-mass",
      },
      principalMoments,
      mass,
      inertiaAtCom,
      inertiaProductParity:
        inertiaProductParity(inertiaAtCom),
      pinnedAxisHandedness,
      inertiaValid:
        inertiaEvaluation.inertiaValid,
      inertiaReliable:
        inertiaEvaluation.inertiaReliable,
      inertiaStatus:
        inertiaEvaluation.inertiaStatus,
    };
  } catch (err) {
    adsk.log(
      `Physical properties unavailable, ` +
      `using bbox fallback: ${err}`
    );

    return fallback;
  }
}


function pinnedAxisHandednessIsSignificant(
  value: number
): boolean {
  return (
    Number.isFinite(value) &&
    Math.abs(value) >= INERTIA_MIN_AXIS_HANDEDNESS
  );
}


function collectBodyMetrics(
  body: adsk.fusion.BRepBody
): BodyMetrics {
  let volume = 0;
  let area = 0;

  try {
    volume = body.volume;
  } catch {
    volume = 0;
  }

  try {
    area = body.area;
  } catch {
    area = 0;
  }

  const physicalMetrics =
    collectPhysicalPropertiesMetrics(body);

  return {
    volume,
    area,
    referencePoint:
      physicalMetrics.referencePoint,
    faceLayout: collectFaceLayout(
      body,
      physicalMetrics.referencePoint
    ),
    principalMoments:
      physicalMetrics.principalMoments,
    mass: physicalMetrics.mass,
    inertiaAtCom:
      physicalMetrics.inertiaAtCom,
    inertiaProductParity:
      physicalMetrics.inertiaProductParity,
    pinnedAxisHandedness:
      physicalMetrics.pinnedAxisHandedness,
    inertiaValid:
      physicalMetrics.inertiaValid,
    inertiaReliable:
      physicalMetrics.inertiaReliable,
    inertiaStatus:
      physicalMetrics.inertiaStatus,
  };
}


function bodiesShareVolumeAndArea(
  left: BodyMetrics,
  right: BodyMetrics
): boolean {
  return (
    metricsClose(left.volume, right.volume) &&
    metricsClose(left.area, right.area)
  );
}


/**
 * Key for the first-pass bucket: volume and area only.
 */
function bulkMetricsKey(
  metrics: BodyMetrics
): string {
  return [
    formatMetric(metrics.volume),
    formatMetric(metrics.area),
  ].join("|");
}


type InertiaHandednessComparison =
  | "same"
  | "opposite"
  | "unknown";


/**
 * Compares chirality using body-attached principal axis handedness only.
 * World-frame off-diagonal products vary with assembly placement and are
 * not compared across bodies.
 */
function compareInertiaHandedness(
  left: BodyMetrics,
  right: BodyMetrics
): InertiaHandednessComparison {
  if (
    !left.inertiaReliable ||
    !right.inertiaReliable
  ) {
    return "unknown";
  }

  const leftPinned =
    left.pinnedAxisHandedness;
  const rightPinned =
    right.pinnedAxisHandedness;

  if (
    !pinnedAxisHandednessIsSignificant(
      leftPinned
    ) ||
    !pinnedAxisHandednessIsSignificant(
      rightPinned
    )
  ) {
    return "unknown";
  }

  return leftPinned * rightPinned > 0
    ? "same"
    : "opposite";
}


function bodiesShareShape(
  left: BodyMetrics,
  right: BodyMetrics
): boolean {
  if (!bodiesShareVolumeAndArea(left, right)) {
    return false;
  }

  return faceLayoutMatch(
    left.faceLayout,
    right.faceLayout
  );
}


/**
 * Same volume/area bucket, same face layout, and same rotation family.
 * Inertia handedness is checked only when available; otherwise treated as same family.
 */
function bodiesSameRotationFamily(
  left: BodyMetrics,
  right: BodyMetrics
): boolean {
  if (!bodiesShareShape(left, right)) {
    return false;
  }

  const handedness =
    compareInertiaHandedness(left, right);

  return handedness !== "opposite";
}


/**
 * Same volume/area bucket and face layout, with conclusive opposite inertia handedness.
 */
function bodiesAreMirrored(
  left: BodyMetrics,
  right: BodyMetrics
): boolean {
  if (!bodiesShareShape(left, right)) {
    return false;
  }

  return (
    compareInertiaHandedness(left, right) ===
    "opposite"
  );
}


/**
 * Same shape and not a mirror — identical or rotated copy.
 */
function bodiesMatch(
  left: BodyMetrics,
  right: BodyMetrics
): boolean {
  return bodiesSameRotationFamily(left, right);
}


function formatMetric(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }

  if (Math.abs(value) < BULK_METRIC_ABS_TOLERANCE) {
    return "0";
  }

  return value.toPrecision(8);
}


/**
 * Stable string fingerprint for logging.
 */
function bodyFingerprint(
  body: adsk.fusion.BRepBody
): string {
  try {
    const metrics =
      collectBodyMetrics(body);
    const ref =
      metrics.referencePoint;

    return [
      formatMetric(metrics.volume),
      formatMetric(metrics.area),
      ref.source,
      formatMetric(ref.x),
      formatMetric(ref.y),
      formatMetric(ref.z),
      metrics.principalMoments
        .map(formatMetric)
        .join(","),
      formatMetric(metrics.inertiaAtCom.ixy),
      formatMetric(metrics.inertiaAtCom.iyz),
      formatMetric(metrics.inertiaAtCom.ixz),
      String(metrics.inertiaProductParity),
      formatMetric(metrics.pinnedAxisHandedness),
      metrics.inertiaValid ? "valid" : "invalid",
      metrics.inertiaReliable ? "reliable" : "unreliable",
      metrics.inertiaStatus,
    ].join("|");
  } catch (err) {
    adsk.log(
      `Body fingerprint fallback after error: ${err}`
    );

    return "fallback";
  }
}


/**
 * Builds a body-level export label. Underscore suffixes are used only here —
 * assemblies and whole-part exports keep the plain part number.
 */
function buildBodyExportLabel(
  componentLabel: string,
  component: adsk.fusion.Component,
  uniqueExportIndex: number,
  uniqueExportCount: number,
  sequenceByUnlabeled: Map<string, number>,
  flatAssembly: boolean
): string {
  const componentNamed = isNamedInFile(
    component.name
  );

  if (flatAssembly || !componentNamed) {
    return buildUnlabeledPartExportLabel(
      sequenceByUnlabeled
    );
  }

  if (uniqueExportCount <= 1) {
    return `${componentLabel}_1`;
  }

  return `${componentLabel}_${uniqueExportIndex}`;
}


/**
 * Labels the full-assembly STEP export. Assembly containers with no direct
 * bodies use the component name as-is; roots that own solid bodies keep
 * the _assembly suffix to distinguish from part exports.
 */
function buildFullAssemblyExportLabel(
  rootComponent: adsk.fusion.Component | null
): string {
  const base = sanitizeName(
    rootComponent?.name || "design"
  );

  if (
    !rootComponent ||
    componentOwnBodyCount(rootComponent) === 0
  ) {
    return base;
  }

  return `${base}_assembly`;
}


/**
 * A flat assembly has bodies parked directly under the root component
 * with no child occurrences — common when STEP was exported as a single
 * part file instead of preserving assembly structure.
 */
function isFlatAssembly(
  rootComponent: adsk.fusion.Component | null
): boolean {
  if (!rootComponent) {
    return false;
  }

  return (
    componentOccurrenceCount(rootComponent) === 0 &&
    componentOwnBodyCount(rootComponent) > 1
  );
}


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


/**
 * Walks the component tree and collects every body in the assembly.
 */
function collectAssemblyBodies(
  rootComponent: adsk.fusion.Component | null,
  hierarchyNames: Set<string> | null = null
): AssemblyBodyRef[] {
  if (!rootComponent) {
    return [];
  }

  function walk(
    component: adsk.fusion.Component | null,
    pathPrefix: string,
    filter: Set<string> | null
  ): AssemblyBodyRef[] {
    if (!component) {
      return [];
    }

    const refs: AssemblyBodyRef[] = [];

    const name =
      component.name ||
      "component";

    const nameMatches =
      !filter ||
      filter.has(name);

    const componentLabel =
      sanitizeName(name);

    const locationPrefix =
      pathPrefix
        ? `${pathPrefix}/${componentLabel}`
        : componentLabel;

    if (nameMatches) {
      const bodyCount =
        componentOwnBodyCount(component);

      for (let i = 0; i < bodyCount; i++) {
        const body =
          component.bRepBodies.item(i);

        const bodyName =
          body.name ||
          `body_${i + 1}`;

        refs.push({
          component,
          componentLabel,
          body,
          bodyName,
          bodyIndex: i + 1,
          location:
            `${locationPrefix}/${bodyName}`,
        });
      }
    }

    for (
      const child of iterChildComponents(component)
    ) {
      refs.push(
        ...walk(
          child,
          locationPrefix,
          filter
        )
      );
    }

    return refs;
  }

  let refs =
    walk(
      rootComponent,
      "",
      hierarchyNames
    );

  if (
    refs.length === 0 &&
    hierarchyNames
  ) {
    refs =
      walk(
        rootComponent,
        "",
        null
      );
  }

  return refs;
}


/**
 * Collects named sub-assemblies — components with child occurrences that
 * are not the design root.
 */
function collectSubAssemblyComponents(
  rootComponent: adsk.fusion.Component
): SubAssemblyExportPlan[] {
  const results: SubAssemblyExportPlan[] = [];

  function walk(
    component: adsk.fusion.Component,
    pathPrefix: string,
    isRoot: boolean
  ): void {
    const rawName = component.name || "";
    const label = sanitizeName(
      rawName || "component"
    );
    const location = pathPrefix
      ? `${pathPrefix}/${label}`
      : label;
    const hasChildren =
      componentOccurrenceCount(component) > 0;

    if (
      !isRoot &&
      hasChildren &&
      isNamedInFile(rawName)
    ) {
      results.push({
        component,
        label,
        location,
        skippedLocations: [],
      });
    }

    for (
      const child of iterChildComponents(component)
    ) {
      walk(child, location, false);
    }
  }

  walk(rootComponent, "", true);

  return results;
}


/**
 * Collects named leaf parts — components that own bodies and have no
 * child occurrences (exported as a whole component with all bodies).
 */
function collectLeafPartComponents(
  rootComponent: adsk.fusion.Component
): PartExportPlan[] {
  const results: PartExportPlan[] = [];

  function walk(
    component: adsk.fusion.Component,
    pathPrefix: string
  ): void {
    const rawName = component.name || "";
    const label = sanitizeName(
      rawName || "component"
    );
    const location = pathPrefix
      ? `${pathPrefix}/${label}`
      : label;
    const bodyCount =
      componentOwnBodyCount(component);
    const hasChildren =
      componentOccurrenceCount(component) > 0;

    if (
      bodyCount > 0 &&
      isNamedInFile(rawName) &&
      !hasChildren
    ) {
      results.push({
        component,
        label,
        location,
        bodyCount,
        skippedLocations: [],
      });
    }

    for (
      const child of iterChildComponents(component)
    ) {
      walk(child, location);
    }
  }

  walk(rootComponent, "");

  return results;
}


/**
 * Keeps one export plan per part number. Additional occurrences with the
 * same name are treated as the same part and not exported again.
 */
function dedupeExportPlansByLabel<
  T extends {
    label: string;
    location: string;
    skippedLocations: string[];
  }
>(
  plans: T[],
  planKind: string
): T[] {
  const byLabel = new Map<string, T>();

  for (const plan of plans) {
    const existing = byLabel.get(plan.label);

    if (existing) {
      existing.skippedLocations.push(
        plan.location
      );

      adsk.log(
        `Skipping duplicate ${planKind} export ` +
        `for "${plan.label}" at "${plan.location}" ` +
        `(same name as "${existing.location}").`
      );

      continue;
    }

    byLabel.set(plan.label, plan);
  }

  adsk.log(
    `Deduped ${planKind} exports by name: ` +
    `${plans.length} occurrence(s) → ` +
    `${byLabel.size} unique file(s).`
  );

  return [...byLabel.values()];
}


/**
 * Groups every assembly body by geometry across the full design.
 */
function buildGlobalBodyExportPlans(
  bodyRefs: AssemblyBodyRef[],
  flatAssembly: boolean
): GlobalBodyExportPlan[] {
  type BodyEntry = {
    ref: AssemblyBodyRef;
    metrics: BodyMetrics;
    fingerprint: string;
  };

  const entries: BodyEntry[] = bodyRefs.map(
    (ref) => {
      const metrics =
        collectBodyMetrics(ref.body);
      const fingerprint =
        bodyFingerprint(ref.body);

      adsk.log(
        `assembly body "${ref.location}" fingerprint: ${fingerprint} ` +
        `(mass ${formatMetric(metrics.mass)} kg, ` +
        `principal moments ${metrics.principalMoments.map(formatMetric).join("/")}, ` +
        `inertia ${metrics.inertiaValid ? "valid" : "invalid"}/` +
        `${metrics.inertiaReliable ? "reliable" : "unreliable"}, ` +
        `status: ${metrics.inertiaStatus}, ` +
        `pinned handedness ${formatMetric(metrics.pinnedAxisHandedness)})`
      );

      return {
        ref,
        metrics,
        fingerprint,
      };
    }
  );

  const validInertiaCount = entries.filter(
    (entry) => entry.metrics.inertiaValid
  ).length;
  const reliableInertiaCount = entries.filter(
    (entry) => entry.metrics.inertiaReliable
  ).length;

  adsk.log(
    `Inertia summary: ${validInertiaCount}/${entries.length} body/bodies ` +
    `have valid mass and principal moments; ` +
    `${reliableInertiaCount}/${entries.length} have reliable axis ` +
    `handedness for mirror detection.`
  );

  const bulkBuckets = new Map<
    string,
    BodyEntry[]
  >();

  for (const entry of entries) {
    const bucketKey =
      bulkMetricsKey(entry.metrics);
    const bucket =
      bulkBuckets.get(bucketKey) ?? [];

    bucket.push(entry);
    bulkBuckets.set(bucketKey, bucket);
  }

  adsk.log(
    `Bulk metric buckets (volume+area): ` +
    `${bulkBuckets.size} bucket(s) for ${entries.length} body/bodies.`
  );

  const parent = entries.map(
    (_, index) => index
  );

  function find(index: number): number {
    const current = parent[index];

    if (current === index) {
      return index;
    }

    const root = find(current);

    parent[index] = root;

    return root;
  }

  function union(
    leftIndex: number,
    rightIndex: number
  ): void {
    const leftRoot = find(leftIndex);
    const rightRoot = find(rightIndex);

    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  }

  for (const bucket of bulkBuckets.values()) {
    if (bucket.length < 2) {
      continue;
    }

    adsk.log(
      `Comparing ${bucket.length} body/bodies ` +
      `in bulk bucket ` +
      `(volume ${formatMetric(bucket[0].metrics.volume)}, ` +
      `area ${formatMetric(bucket[0].metrics.area)}).`
    );

    for (
      let leftOffset = 0;
      leftOffset < bucket.length;
      leftOffset++
    ) {
      for (
        let rightOffset = leftOffset + 1;
        rightOffset < bucket.length;
        rightOffset++
      ) {
        const leftEntry = bucket[leftOffset];
        const rightEntry = bucket[rightOffset];

        if (
          bodiesSameRotationFamily(
            leftEntry.metrics,
            rightEntry.metrics
          )
        ) {
          union(
            entries.indexOf(leftEntry),
            entries.indexOf(rightEntry)
          );

          adsk.log(
            `Linked "${leftEntry.ref.location}" with ` +
            `"${rightEntry.ref.location}" ` +
            `(same rotation family).`
          );
        } else if (
          bodiesShareShape(
            leftEntry.metrics,
            rightEntry.metrics
          )
        ) {
          adsk.log(
            `Shape match but different family: ` +
            `"${leftEntry.ref.location}" vs ` +
            `"${rightEntry.ref.location}" ` +
            `(pinned handedness ${formatMetric(leftEntry.metrics.pinnedAxisHandedness)} vs ` +
            `${formatMetric(rightEntry.metrics.pinnedAxisHandedness)}, ` +
            `inertia reliable ${leftEntry.metrics.inertiaReliable}/` +
            `${rightEntry.metrics.inertiaReliable}).`
          );
        } else if (
          bodiesShareVolumeAndArea(
            leftEntry.metrics,
            rightEntry.metrics
          )
        ) {
          adsk.log(
            `Same volume/area but different shape: ` +
            `"${leftEntry.ref.location}" vs ` +
            `"${rightEntry.ref.location}".`
          );
        }
      }
    }
  }

  const groups = new Map<
    number,
    BodyEntry[]
  >();

  for (
    let index = 0;
    index < entries.length;
    index++
  ) {
    const root = find(index);
    const group = groups.get(root) ?? [];

    group.push(entries[index]);
    groups.set(root, group);
  }

  const exportSequenceByUnlabeled =
    new Map<string, number>();

  const pendingGroups: Array<{
    lead: BodyEntry;
    group: BodyEntry[];
  }> = [];

  for (const group of groups.values()) {
    pendingGroups.push({
      lead: group[0],
      group,
    });
  }

  const multiBodyPending = pendingGroups.filter(
    (pending) =>
      componentOwnBodyCount(
        pending.lead.ref.component
      ) > 1
  );

  const uniqueExportCountByComponent =
    new Map<string, number>();

  for (const pending of multiBodyPending) {
    const key =
      pending.lead.ref.componentLabel;

    uniqueExportCountByComponent.set(
      key,
      (uniqueExportCountByComponent.get(key) ??
        0) + 1
    );
  }

  const exportSequenceByComponent =
    new Map<string, number>();

  const duplicateGroups: Array<{
    metrics: BodyMetrics;
    fingerprint: string;
    exportLabel: string;
    matchedInstances: GlobalBodyExportPlan["matchedInstances"];
    body: adsk.fusion.BRepBody;
  }> = [];

  for (const pending of multiBodyPending) {
    const lead = pending.lead;
    const componentKey =
      lead.ref.componentLabel;
    const uniqueExportCount =
      uniqueExportCountByComponent.get(
        componentKey
      ) ?? 1;
    const uniqueExportIndex =
      (exportSequenceByComponent.get(
        componentKey
      ) ?? 0) + 1;

    exportSequenceByComponent.set(
      componentKey,
      uniqueExportIndex
    );

    const exportLabel =
      buildBodyExportLabel(
        lead.ref.componentLabel,
        lead.ref.component,
        uniqueExportIndex,
        uniqueExportCount,
        exportSequenceByUnlabeled,
        flatAssembly
      );

    duplicateGroups.push({
      metrics: lead.metrics,
      fingerprint: lead.fingerprint,
      exportLabel,
      matchedInstances: pending.group.map(
        (entry) => ({
          componentLabel:
            entry.ref.componentLabel,
          bodyName: entry.ref.bodyName,
          location: entry.ref.location,
        })
      ),
      body: lead.ref.body,
    });

    for (const entry of pending.group) {
      if (entry === lead) {
        continue;
      }

      adsk.log(
        `Grouped body "${entry.ref.location}" ` +
        `with "${lead.ref.location}" as "${exportLabel}".`
      );
    }
  }

  adsk.log(
    `Assembly-wide dedup: ${bodyRefs.length} body/bodies, ` +
    `${duplicateGroups.length} unique body export(s) from ` +
    `multi-body part(s).`
  );

  return duplicateGroups.map(
    (group) => ({
      body: group.body,
      metrics: group.metrics,
      fingerprint: group.fingerprint,
      exportLabel: group.exportLabel,
      matchedInstances: [...group.matchedInstances],
      instanceCount: group.matchedInstances.length,
    })
  );
}


/**
 * Maps each export label to other exported parts that are direct mirror
 * variants (same volume/area and face layout, opposite inertia handedness).
 * Only pairwise matches are recorded — no transitive linking across parts.
 */
function buildMirrorPartLinks(
  exportPlans: GlobalBodyExportPlan[]
): Map<string, string[]> {
  const mirrorLinks = new Map<string, string[]>();

  function addMirrorLink(
    leftLabel: string,
    rightLabel: string
  ): void {
    const leftLinks =
      mirrorLinks.get(leftLabel) ?? [];
    const rightLinks =
      mirrorLinks.get(rightLabel) ?? [];

    if (!leftLinks.includes(rightLabel)) {
      leftLinks.push(rightLabel);
      mirrorLinks.set(leftLabel, leftLinks);
    }

    if (!rightLinks.includes(leftLabel)) {
      rightLinks.push(leftLabel);
      mirrorLinks.set(rightLabel, rightLinks);
    }
  }

  for (let i = 0; i < exportPlans.length; i++) {
    for (
      let j = i + 1;
      j < exportPlans.length;
      j++
    ) {
      const leftPlan = exportPlans[i];
      const rightPlan = exportPlans[j];

      if (
        !bodiesShareVolumeAndArea(
          leftPlan.metrics,
          rightPlan.metrics
        )
      ) {
        continue;
      }

      if (
        bodiesAreMirrored(
          leftPlan.metrics,
          rightPlan.metrics
        )
      ) {
        addMirrorLink(
          leftPlan.exportLabel,
          rightPlan.exportLabel
        );

        const handednessProduct =
          leftPlan.metrics.pinnedAxisHandedness *
          rightPlan.metrics.pinnedAxisHandedness;

        adsk.log(
          `Detected mirrored pair: "${leftPlan.exportLabel}" ` +
          `and "${rightPlan.exportLabel}" ` +
          `(volume ${formatMetric(leftPlan.metrics.volume)}, ` +
          `area ${formatMetric(leftPlan.metrics.area)}, ` +
          `opposite pinned handedness: ${formatMetric(leftPlan.metrics.pinnedAxisHandedness)} ` +
          `vs ${formatMetric(rightPlan.metrics.pinnedAxisHandedness)}, ` +
          `product ${formatMetric(handednessProduct)}).`
        );
      }
    }
  }

  for (const [label, links] of mirrorLinks.entries()) {
    mirrorLinks.set(
      label,
      [...links].sort()
    );
  }

  return mirrorLinks;
}


function warnIfFlatAssembly(
  rootComponent: adsk.fusion.Component,
  bodyCount: number
): void {
  if (!isFlatAssembly(rootComponent)) {
    return;
  }

  adsk.log(
    "Flat assembly detected: the design has " +
    `${bodyCount} body/bodies under the root component and no child ` +
    "components. This usually means a STEP file was exported without " +
    "assembly hierarchy. Duplicate bodies anywhere in the assembly are " +
    "grouped by geometry and exported once with a total quantity. " +
    "For best results, upload native .f3d or export STEP with assembly " +
    "structure preserved."
  );
}


/**
 * Splits one body out of a component into its own temporary component.
 */
function splitSingleBodyIntoUnit(
  design: adsk.fusion.Design | null,
  rootComponent: adsk.fusion.Component,
  body: adsk.fusion.BRepBody,
  label: string,
  sourceKind: ExportUnit["sourceKind"] = "global-part"
): ExportUnit | null {
  const bodyName =
    body.name ||
    label;

  try {
    const matrix =
      adsk.core.Matrix3D.create();

    const occurrence =
      rootComponent.occurrences
        .addNewComponent(matrix);

    const newComponent =
      occurrence.component;

    newComponent.name =
      sanitizeName(label || bodyName);

    placeBodyInComponent(
      design,
      body,
      newComponent
    );

    return {
      label: newComponent.name,
      component: newComponent,
      sourceKind,
    };
  } catch (err) {
    adsk.log(
      `Could not split body "${bodyName}" ` +
      `for export as "${label}": ${err}`
    );

    return null;
  }
}


/**
 * Creates export units for globally unique parts after the full assembly
 * STEP has been written.
 */
function materializeGlobalExportUnits(
  design: adsk.fusion.Design | null,
  rootComponent: adsk.fusion.Component,
  exportPlans: GlobalBodyExportPlan[]
): ExportUnit[] {
  const units: ExportUnit[] = [];

  for (const plan of exportPlans) {
    const unit =
      splitSingleBodyIntoUnit(
        design,
        rootComponent,
        plan.body,
        plan.exportLabel,
        "body"
      );

    if (!unit) {
      continue;
    }

    unit.fingerprint = plan.fingerprint;
    unit.matchedBodyNames =
      plan.matchedInstances.map(
        (instance) => instance.location
      );
    unit.instanceCount = plan.instanceCount;

    units.push(unit);
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
      fingerprint: unit.fingerprint,
      instanceCount: unit.instanceCount,
      matchedBodyNames: unit.matchedBodyNames
        ? [...unit.matchedBodyNames]
        : undefined,
    });
  }


  return {
    outputFiles,
    componentEntries,
  };
}


function exportLabelToPartFile(
  exportLabel: string
): string {
  return `${exportLabel}.step`;
}


/**
 * Summarizes exported unique parts: output filename, quantity, and
 * assembly locations for each component instance.
 */
function buildPartsManifest(
  entries: ComponentEntry[],
  mirrorLinks: Map<string, string[]>
): PartsManifestEntry[] {
  return entries
    .filter(
      (entry) => entry.source !== "full-assembly"
    )
    .map((entry) => {
      const manifest: PartsManifestEntry = {
        part: entry.outputFile.replace(/^.*[/\\]/, ""),
        quantity: entry.instanceCount ?? 1,
        locations: entry.matchedBodyNames
          ? [...entry.matchedBodyNames]
          : [],
      };

      const mirroredLabels =
        mirrorLinks.get(entry.componentName);

      if (
        mirroredLabels &&
        mirroredLabels.length > 0
      ) {
        manifest.mirrors =
          mirroredLabels.map(exportLabelToPartFile);
      }

      return manifest;
    });
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
 * Exports each named sub-assembly component as its own STEP file.
 */
function exportSubAssembliesToStep(
  design: adsk.fusion.Design,
  outputDir: string,
  plans: SubAssemblyExportPlan[],
  usedNames: Set<string>,
  exportedLabels: Set<string>
): ComponentEntry[] {
  const entries: ComponentEntry[] = [];

  for (const plan of plans) {
    if (exportedLabels.has(plan.label)) {
      adsk.log(
        `Skipping sub-assembly "${plan.label}" — ` +
        `already exported under this name.`
      );
      continue;
    }

    const outputPath =
      uniqueOutputPath(
        outputDir,
        plan.label,
        usedNames
      );

    adsk.log(
      `Exporting sub-assembly "${plan.label}" ` +
      `to ${outputPath}`
    );

    const options =
      design.exportManager
        .createSTEPExportOptions(
          outputPath,
          plan.component
        );

    const success =
      design.exportManager
        .execute(options);

    if (!success) {
      adsk.log(
        `Sub-assembly export did not complete ` +
        `for "${plan.label}".`
      );
      continue;
    }

    exportedLabels.add(plan.label);

    entries.push({
      componentName: plan.label,
      outputFile: outputPath,
      source: "sub-assembly",
      instanceCount:
        1 + plan.skippedLocations.length,
      matchedBodyNames: [
        plan.location,
        ...plan.skippedLocations,
      ],
    });

    adsk.log(
      `Exported sub-assembly: ${outputPath}`
    );
  }

  return entries;
}


/**
 * Exports each named leaf part (whole component with all bodies).
 */
function exportPartsToStep(
  design: adsk.fusion.Design,
  outputDir: string,
  plans: PartExportPlan[],
  usedNames: Set<string>,
  exportedLabels: Set<string>
): ComponentEntry[] {
  const entries: ComponentEntry[] = [];

  for (const plan of plans) {
    if (exportedLabels.has(plan.label)) {
      adsk.log(
        `Skipping part "${plan.label}" — ` +
        `already exported under this name.`
      );
      continue;
    }

    const outputPath =
      uniqueOutputPath(
        outputDir,
        plan.label,
        usedNames
      );

    adsk.log(
      `Exporting part "${plan.label}" ` +
      `(${plan.bodyCount} body/bodies) ` +
      `to ${outputPath}`
    );

    const options =
      design.exportManager
        .createSTEPExportOptions(
          outputPath,
          plan.component
        );

    const success =
      design.exportManager
        .execute(options);

    if (!success) {
      adsk.log(
        `Part export did not complete ` +
        `for "${plan.label}".`
      );
      continue;
    }

    exportedLabels.add(plan.label);

    const locations = [
      plan.location,
      ...plan.skippedLocations,
    ];

    entries.push({
      componentName: plan.label,
      outputFile: outputPath,
      source: "part",
      instanceCount: locations.length,
      matchedBodyNames: locations,
    });

    adsk.log(
      `Exported part: ${outputPath}`
    );
  }

  return entries;
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
    // 7. Collect all bodies and plan assembly-wide deduplication
    // ---------------------------------------------------------

    const bodyRefs =
      collectAssemblyBodies(
        rootComponent,
        hierarchyNames
      );

    const steelMaterial =
      findTemporarySteelMaterial(app);

    let materialSnapshots: BodyMaterialSnapshot[] =
      [];

    if (steelMaterial) {
      adsk.log(
        `Applying temporary steel material (${steelMaterial.name}) ` +
        `for inertia-based comparison.`
      );

      materialSnapshots =
        applyTemporarySteelMaterials(
          bodyRefs,
          steelMaterial
        );

      adsk.doEvents();
    } else {
      adsk.log(
        "Could not find a steel material in the library; " +
        "inertia comparison may be unreliable."
      );
    }

    const flatAssembly =
      isFlatAssembly(rootComponent);

    let globalExportPlans:
      GlobalBodyExportPlan[] = [];

    let mirrorPartLinks =
      new Map<string, string[]>();

    try {
      globalExportPlans =
        buildGlobalBodyExportPlans(
          bodyRefs,
          flatAssembly
        );

      mirrorPartLinks =
        buildMirrorPartLinks(
          globalExportPlans
        );
    } finally {
      if (materialSnapshots.length > 0) {
        restoreBodyMaterials(
          materialSnapshots
        );

        adsk.doEvents();

        adsk.log(
          "Restored original body materials after comparison."
        );
      }
    }

    warnIfFlatAssembly(
      rootComponent,
      bodyRefs.length
    );

    adsk.log(
      `Planned ${globalExportPlans.length} unique part export(s) ` +
      `from ${bodyRefs.length} body/bodies across the assembly.`
    );


    const usedOutputNames = new Set<string>();
    const exportedLabels = new Set<string>();


    // ---------------------------------------------------------
    // 8. Export complete assembly before mutating the design
    // ---------------------------------------------------------

    let allOutputFiles: string[] = [];

    let allComponentEntries: ComponentEntry[] = [];


    const shouldExportFullAssembly =
      bodyRefs.length > 1;


    if (shouldExportFullAssembly) {

      const assemblyLabel =
        buildFullAssemblyExportLabel(
          rootComponent
        );


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

      exportedLabels.add(assemblyLabel);


      adsk.log(
        `Exported full assembly: ` +
        `${assemblyFile}`
      );
    }


    // ---------------------------------------------------------
    // 8b. Export named sub-assemblies
    // ---------------------------------------------------------

    const subAssemblyPlans =
      dedupeExportPlansByLabel(
        collectSubAssemblyComponents(
          rootComponent
        ),
        "sub-assembly"
      );

    if (subAssemblyPlans.length > 0) {
      adsk.log(
        `Exporting ${subAssemblyPlans.length} ` +
        `named sub-assembly/sub-assemblies: ` +
        `${subAssemblyPlans.map(
          (plan) => plan.label
        ).join(", ")}`
      );

      const subAssemblyEntries =
        exportSubAssembliesToStep(
          design,
          outputDir,
          subAssemblyPlans,
          usedOutputNames,
          exportedLabels
        );

      allOutputFiles = [
        ...allOutputFiles,
        ...subAssemblyEntries.map(
          (entry) => entry.outputFile
        ),
      ];

      allComponentEntries = [
        ...allComponentEntries,
        ...subAssemblyEntries,
      ];
    }


    // ---------------------------------------------------------
    // 8c. Export named leaf parts (whole component, all bodies)
    // ---------------------------------------------------------

    const partPlans =
      dedupeExportPlansByLabel(
        collectLeafPartComponents(
          rootComponent
        ),
        "part"
      );

    if (partPlans.length > 0) {
      adsk.log(
        `Exporting ${partPlans.length} ` +
        `named part(s): ` +
        `${partPlans.map(
          (plan) => plan.label
        ).join(", ")}`
      );

      const partEntries =
        exportPartsToStep(
          design,
          outputDir,
          partPlans,
          usedOutputNames,
          exportedLabels
        );

      allOutputFiles = [
        ...allOutputFiles,
        ...partEntries.map(
          (entry) => entry.outputFile
        ),
      ];

      allComponentEntries = [
        ...allComponentEntries,
        ...partEntries,
      ];
    }


    // ---------------------------------------------------------
    // 9. Export deduplicated bodies from multi-body parts
    // ---------------------------------------------------------

    const units =
      materializeGlobalExportUnits(
        design,
        rootComponent,
        globalExportPlans
      );

    adsk.log(
      `Materialized ${units.length} unique body export unit(s): ` +
      `${units.map(
        (u) => u.label
      ).join(", ")}`
    );

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


    const partsManifest =
      buildPartsManifest(
        allComponentEntries,
        mirrorPartLinks
      );

    const manifestPath =
      `${outputDir}/parts-manifest.json`;

    writeFileSync(
      manifestPath,
      JSON.stringify(partsManifest, null, 2)
    );

    adsk.log(
      `Wrote parts manifest to ${manifestPath}`
    );


    let outputZip: string | null = null;

    if (allOutputFiles.length > 0) {
      outputZip = "exports.zip";

      adsk.log(
        `Packaging ${allOutputFiles.length} STEP file(s) ` +
        `and manifest into ${outputZip}`
      );

      writeZipArchive(
        outputZip,
        [
          ...allOutputFiles,
          manifestPath,
        ]
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

        manifestFile:
          manifestPath,

        parts:
          partsManifest,
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
