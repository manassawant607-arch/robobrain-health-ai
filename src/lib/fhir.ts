/**
 * Clean Data Exchange — HL7 FHIR R4 export for decision-support reports.
 *
 * Maps a RoboBrain case (AI report + patient context) into a FHIR R4
 * `collection` Bundle that any FHIR-aware EHR, HIE gateway, or research
 * pipeline (including Japan's JP Core profile, which derives from R4 base)
 * can consume without custom parsing. `validateFhirBundle` enforces the
 * structural contract so downstream systems never receive a broken payload.
 */
import type { Case, PatientProfile, Severity, Vitals } from '@/types'
import { categoryById } from './data'

/* ---------------------------------- types ---------------------------------- */

export interface FhirCoding {
  system?: string
  code?: string
  display?: string
}

export interface FhirCodeableConcept {
  coding?: FhirCoding[]
  text?: string
}

export interface FhirReference {
  reference?: string
  display?: string
}

export interface FhirResource {
  resourceType: string
  id: string
  meta?: { tag?: FhirCoding[] }
  [key: string]: unknown
}

export interface FhirEntry {
  fullUrl: string
  resource: FhirResource
}

export interface FhirBundle {
  resourceType: 'Bundle'
  id: string
  type: 'collection'
  timestamp: string
  entry: FhirEntry[]
}

const LOINC = 'http://loinc.org'
const UCUM = 'http://unitsofmeasure.org'
const FHIR_SECURITY = 'http://terminology.hl7.org/CodeSystem/v3-ActReason'
const ROBOBRAIN = 'https://robobrain.health'

/** Everything the mesh emits is synthetic demo data — label it so receivers never mistake it for PHI. */
const SYNTHETIC_TAG: FhirCoding = { system: FHIR_SECURITY, code: 'HTEST', display: 'test health data' }

const ref = (fullUrl: string, display?: string): FhirReference => ({ reference: fullUrl, display })

const severityToPriority: Record<Severity, string> = {
  low: 'routine',
  moderate: 'urgent',
  high: 'asap',
  critical: 'stat',
}

const severityToRiskCode: Record<Severity, string> = {
  low: 'low',
  moderate: 'moderate',
  high: 'high',
  critical: 'critical',
}

/* ------------------------------ vital signs ------------------------------ */

interface VitalSpec {
  loinc: string
  display: string
  unit: string
  ucum: string
  read: (v: Vitals) => number
}

const VITAL_SPECS: VitalSpec[] = [
  { loinc: '8480-6', display: 'Systolic blood pressure', unit: 'mmHg', ucum: 'mm[Hg]', read: (v) => v.systolic },
  { loinc: '8462-4', display: 'Diastolic blood pressure', unit: 'mmHg', ucum: 'mm[Hg]', read: (v) => v.diastolic },
  { loinc: '8867-4', display: 'Heart rate', unit: 'beats/min', ucum: '/min', read: (v) => v.heartRate },
  { loinc: '8310-5', display: 'Body temperature', unit: '°C', ucum: 'Cel', read: (v) => v.temperatureC },
  { loinc: '59408-5', display: 'Oxygen saturation (pulse oximetry)', unit: '%', ucum: '%', read: (v) => v.spo2 },
  { loinc: '2339-0', display: 'Glucose [Mass/volume] in Blood', unit: 'mg/dL', ucum: 'mg/dL', read: (v) => v.glucoseMgDl },
  { loinc: '2093-3', display: 'Total cholesterol [Mass/volume] in Serum or Plasma', unit: 'mg/dL', ucum: 'mg/dL', read: (v) => v.cholesterolMgDl },
]

/* ------------------------------- builders -------------------------------- */

function buildPatient(c: Case): FhirResource {
  const gender = c.sex === 'male' || c.sex === 'female' ? c.sex : 'other'
  // FHIR Patient has birthDate but no age field; approximate the birth year.
  const birthYear = new Date(c.createdAt).getUTCFullYear() - c.age
  return {
    resourceType: 'Patient',
    id: `patient-${c.patientId}`,
    meta: { tag: [SYNTHETIC_TAG] },
    active: true,
    name: [{ use: 'usual', text: c.patientName }],
    gender,
    birthDate: String(birthYear),
  }
}

function buildDevice(): FhirResource {
  return {
    resourceType: 'Device',
    id: 'robobrain-agent-mesh',
    meta: { tag: [SYNTHETIC_TAG] },
    status: 'active',
    deviceName: [{ name: 'RoboBrain Health AI agent mesh', type: 'model-name' }],
    type: { text: 'Clinical decision-support software (SaMD demo)' },
  }
}

function buildVitalObservations(profile: PatientProfile, c: Case, patientUrl: string, deviceUrl: string): FhirResource[] {
  return VITAL_SPECS.map((spec, i) => ({
    resourceType: 'Observation',
    id: `obs-vital-${c.id}-${i}`,
    meta: { tag: [SYNTHETIC_TAG] },
    status: 'final',
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/observation-category',
            code: 'vital-signs',
            display: 'Vital Signs',
          },
        ],
      },
    ],
    code: { coding: [{ system: LOINC, code: spec.loinc, display: spec.display }], text: spec.display },
    subject: ref(patientUrl, c.patientName),
    device: ref(deviceUrl, 'RoboBrain Health AI agent mesh'),
    effectiveDateTime: c.createdAt,
    valueQuantity: {
      value: spec.read(profile.vitals),
      unit: spec.unit,
      system: UCUM,
      code: spec.ucum,
    },
  }))
}

function buildConditions(c: Case, patientUrl: string, deviceUrl: string): FhirResource[] {
  const findings = c.report?.symptomAnalysis?.findings ?? []
  return findings.map((f, i) => ({
    resourceType: 'Condition',
    id: `condition-${c.id}-${i}`,
    meta: { tag: [SYNTHETIC_TAG] },
    clinicalStatus: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }],
    },
    verificationStatus: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-ver-status', code: 'provisional' }],
    },
    category: [{ text: categoryById(f.category).name }],
    code: { text: f.condition },
    subject: ref(patientUrl, c.patientName),
    recorder: ref(deviceUrl, 'RoboBrain Health AI agent mesh'),
    recordedDate: c.createdAt,
    note: [{ text: `${f.rationale} (AI confidence ${f.confidence}%)` }],
    extension: [
      {
        url: `${ROBOBRAIN}/fhir/StructureDefinition/ai-confidence`,
        valueInteger: f.confidence,
      },
    ],
  }))
}

function buildMedications(c: Case, patientUrl: string): FhirResource[] {
  return c.medications.map((med, i) => ({
    resourceType: 'MedicationStatement',
    id: `med-${c.id}-${i}`,
    meta: { tag: [SYNTHETIC_TAG] },
    status: 'active',
    medicationCodeableConcept: { text: med },
    subject: ref(patientUrl, c.patientName),
    effectiveDateTime: c.createdAt,
    informationSource: ref(patientUrl, c.patientName),
  }))
}

function buildRiskAssessment(c: Case, patientUrl: string, deviceUrl: string): FhirResource | null {
  const risk = c.report?.diseaseRisk
  if (!risk) return null
  return {
    resourceType: 'RiskAssessment',
    id: `risk-${c.id}`,
    meta: { tag: [SYNTHETIC_TAG] },
    status: 'final',
    subject: ref(patientUrl, c.patientName),
    occurrenceDateTime: c.createdAt,
    performer: ref(deviceUrl, 'RoboBrain Health AI agent mesh'),
    basis: [{ text: c.symptomsText }],
    prediction: risk.scores.map((s) => ({
      outcome: { text: categoryById(s.category).name },
      probabilityDecimal: Math.round(s.score) / 100,
      qualitativeRisk: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/risk-probability',
            code: severityToRiskCode[s.band],
          },
        ],
      },
      rationale: s.drivers.join('; '),
    })),
    note: [{ text: `Composite risk ${risk.overall}/100 (RoboBrain Disease Risk Agent)` }],
  }
}

function buildReferral(c: Case, patientUrl: string, deviceUrl: string): FhirResource | null {
  const referral = c.report?.referral
  if (!referral) return null
  return {
    resourceType: 'ServiceRequest',
    id: `referral-${c.id}`,
    meta: { tag: [SYNTHETIC_TAG] },
    status: 'active',
    intent: 'proposal',
    priority: severityToPriority[referral.urgency],
    category: [{ text: `Referral to ${referral.specialty}` }],
    code: { text: `${referral.specialty} consultation` },
    subject: ref(patientUrl, c.patientName),
    requester: ref(deviceUrl, 'RoboBrain Health AI agent mesh'),
    reasonCode: [{ text: referral.reason }],
    supportingInfo: referral.suggestedTests.map((t) => ({ display: t })),
    note: referral.recommendedDoctor
      ? [{ text: `Suggested clinician: ${referral.recommendedDoctor}` }]
      : undefined,
  }
}

function buildRedFlags(c: Case, patientUrl: string): FhirResource[] {
  const flags = c.report?.symptomAnalysis?.redFlags ?? []
  return flags.map((flag, i) => ({
    resourceType: 'Flag',
    id: `flag-${c.id}-${i}`,
    meta: { tag: [SYNTHETIC_TAG] },
    status: 'active',
    category: [{ text: 'Clinical red flag' }],
    code: { text: flag },
    subject: ref(patientUrl, c.patientName),
    period: { start: c.createdAt },
  }))
}

function buildProvenance(c: Case, reportUrl: string, deviceUrl: string): FhirResource[] {
  const entries: FhirResource[] = [
    {
      resourceType: 'Provenance',
      id: `prov-ai-${c.id}`,
      meta: { tag: [SYNTHETIC_TAG] },
      target: [ref(reportUrl, 'RoboBrain AI decision-support report')],
      recorded: c.report?.generatedAt ?? c.createdAt,
      activity: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/provenance-activity-type',
            code: 'GENERATE',
            display: 'generate',
          },
        ],
      },
      agent: [
        {
          type: { text: 'AI decision-support software' },
          who: ref(deviceUrl, 'RoboBrain Health AI agent mesh'),
        },
      ],
    },
  ]
  if (c.doctorNote) {
    const activityCode =
      c.doctorNote.decision === 'agree' ? 'VERIFY' : c.doctorNote.decision === 'modify' ? 'UPDATE' : 'ESCALATE'
    entries.push({
      resourceType: 'Provenance',
      id: `prov-review-${c.id}`,
      meta: { tag: [SYNTHETIC_TAG] },
      target: [ref(reportUrl, 'RoboBrain AI decision-support report')],
      recorded: c.doctorNote.createdAt,
      activity: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/provenance-activity-type',
            code: activityCode,
          },
        ],
        text: `Clinician decision: ${c.doctorNote.decision}`,
      },
      agent: [
        {
          type: { text: 'Reviewing clinician' },
          who: { display: c.doctorNote.doctorName },
        },
      ],
      reason: [{ text: c.doctorNote.note }],
    })
  }
  return entries
}

/* ------------------------------ public API ------------------------------- */

/**
 * Convert a case into a FHIR R4 collection Bundle. Pass the patient profile
 * when available (same patientId) to include coded vital-sign Observations.
 * Output is deterministic for a given case, so exports are diff-able.
 */
export function buildFhirBundle(c: Case, profile?: PatientProfile): FhirBundle {
  const entries: FhirEntry[] = []
  const add = (resource: FhirResource): string => {
    const fullUrl = `urn:uuid:${resource.id}`
    entries.push({ fullUrl, resource })
    return fullUrl
  }

  const patientUrl = add(buildPatient(c))
  const deviceUrl = add(buildDevice())

  const observations =
    profile && profile.id === c.patientId
      ? buildVitalObservations(profile, c, patientUrl, deviceUrl)
      : []
  observations.forEach((o) => add(o))

  const conditions = buildConditions(c, patientUrl, deviceUrl)
  conditions.forEach((cond) => add(cond))
  buildMedications(c, patientUrl).forEach((m) => add(m))

  const risk = buildRiskAssessment(c, patientUrl, deviceUrl)
  if (risk) add(risk)
  const referral = buildReferral(c, patientUrl, deviceUrl)
  if (referral) add(referral)
  buildRedFlags(c, patientUrl).forEach((f) => add(f))

  const report: FhirResource = {
    resourceType: 'DiagnosticReport',
    id: `report-${c.id}`,
    meta: { tag: [SYNTHETIC_TAG] },
    status: c.doctorNote ? 'final' : 'preliminary',
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/v2-0074',
            code: 'OTH',
            display: 'Other',
          },
        ],
      },
    ],
    code: { text: 'RoboBrain AI decision-support report' },
    subject: ref(patientUrl, c.patientName),
    effectiveDateTime: c.createdAt,
    issued: c.report?.generatedAt ?? c.createdAt,
    performer: [ref(deviceUrl, 'RoboBrain Health AI agent mesh')],
    result: [...observations, ...conditions].map((r) => ref(`urn:uuid:${r.id}`)),
    conclusion: c.report ? `${c.report.headline}\n\n${c.report.narrative}` : c.title,
    conclusionCode: c.report?.triage
      ? [{ text: `Autonomous triage: ${c.report.triage.destination} — ${c.report.triage.rationale}` }]
      : undefined,
  }
  const reportUrl = add(report)
  buildProvenance(c, reportUrl, deviceUrl).forEach((p) => add(p))

  return {
    resourceType: 'Bundle',
    id: `bundle-${c.id}`,
    type: 'collection',
    timestamp: c.updatedAt,
    entry: entries,
  }
}

/** Resource counts by type, for display ("Patient ×1, Observation ×7, …"). */
export function bundleStats(bundle: FhirBundle): Record<string, number> {
  const stats: Record<string, number> = {}
  for (const e of bundle.entry) {
    stats[e.resource.resourceType] = (stats[e.resource.resourceType] ?? 0) + 1
  }
  return stats
}

const REQUIRED_FIELDS: Record<string, string[]> = {
  Patient: ['name', 'gender'],
  Observation: ['status', 'code', 'subject'],
  Condition: ['code', 'subject'],
  MedicationStatement: ['status', 'medicationCodeableConcept', 'subject'],
  RiskAssessment: ['status', 'subject', 'prediction'],
  ServiceRequest: ['status', 'intent', 'subject'],
  Flag: ['status', 'code', 'subject'],
  DiagnosticReport: ['status', 'code', 'subject'],
  Provenance: ['target', 'recorded', 'agent'],
}

/**
 * Structural validation of an export. Returns a list of issues; an empty
 * list means the bundle is safe to hand to another system. Checks the
 * contract a receiver actually depends on: bundle shape, unique ids,
 * resolvable internal references, and per-resource required fields.
 */
export function validateFhirBundle(bundle: unknown): string[] {
  const issues: string[] = []
  const b = bundle as Partial<FhirBundle>
  if (!b || typeof b !== 'object') return ['payload is not an object']
  if (b.resourceType !== 'Bundle') issues.push('resourceType must be "Bundle"')
  if (b.type !== 'collection') issues.push('Bundle.type must be "collection"')
  if (!Array.isArray(b.entry) || b.entry.length === 0) {
    issues.push('Bundle.entry must be a non-empty array')
    return issues
  }

  const urls = new Set<string>()
  const ids = new Set<string>()
  for (const [i, entry] of b.entry.entries()) {
    const r = entry?.resource
    if (!entry?.fullUrl) issues.push(`entry[${i}] is missing fullUrl`)
    if (!r?.resourceType) issues.push(`entry[${i}] is missing resource.resourceType`)
    if (!r?.id) issues.push(`entry[${i}] (${r?.resourceType ?? '?'}) is missing resource.id`)
    if (entry?.fullUrl) {
      if (urls.has(entry.fullUrl)) issues.push(`duplicate fullUrl ${entry.fullUrl}`)
      urls.add(entry.fullUrl)
    }
    if (r?.id) {
      if (ids.has(r.id)) issues.push(`duplicate resource id ${r.id}`)
      ids.add(r.id)
    }
    for (const field of REQUIRED_FIELDS[r?.resourceType ?? ''] ?? []) {
      if (r?.[field] === undefined) issues.push(`${r.resourceType}/${r.id} is missing ${field}`)
    }
  }

  const checkRef = (value: unknown, path: string) => {
    if (typeof value === 'string' && value.startsWith('urn:uuid:') && !urls.has(value)) {
      issues.push(`unresolved reference ${value} at ${path}`)
    }
  }
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`))
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'reference') checkRef(v, `${path}.reference`)
        else walk(v, `${path}.${k}`)
      }
    }
  }
  walk(b.entry, 'entry')

  return issues
}
