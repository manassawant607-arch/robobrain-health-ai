import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { buildCaseFromSubmission as BuildCase } from './agents'
import type { DEMO_PROFILE as DemoProfile } from './data'
import type { Case } from '@/types'
import type { FhirBundle, FhirResource } from './fhir'

// Agents/learning touch localStorage at module load — stub before importing.
let buildCaseFromSubmission: typeof BuildCase
let DEMO_PROFILE: typeof DemoProfile
let buildFhirBundle: (c: Case, p?: typeof DEMO_PROFILE) => FhirBundle
let validateFhirBundle: (b: unknown) => string[]
let bundleStats: (b: FhirBundle) => Record<string, number>

beforeAll(async () => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  })
  ;({ buildCaseFromSubmission } = await import('./agents'))
  ;({ DEMO_PROFILE } = await import('./data'))
  ;({ buildFhirBundle, validateFhirBundle, bundleStats } = await import('./fhir'))
})

function makeCase(): Case {
  return buildCaseFromSubmission({
    profile: DEMO_PROFILE,
    title: 'Chest tightness & breathlessness',
    type: 'symptoms',
    symptomsText:
      'Chest tightness on exertion for 3 days, radiating to left arm, shortness of breath, sweating.',
    medications: ['Metformin 1000mg', 'Amlodipine 5mg'],
    attachments: [],
  })
}

const resources = (b: FhirBundle, type: string): FhirResource[] =>
  b.entry.map((e) => e.resource).filter((r) => r.resourceType === type)

describe('buildFhirBundle', () => {
  it('produces a FHIR R4 collection bundle with a stable id', () => {
    const c = makeCase()
    const b = buildFhirBundle(c, DEMO_PROFILE)
    expect(b.resourceType).toBe('Bundle')
    expect(b.type).toBe('collection')
    expect(b.id).toBe(`bundle-${c.id}`)
    expect(b.timestamp).toBe(c.updatedAt)
  })

  it('is deterministic for the same case', () => {
    const c = makeCase()
    expect(JSON.stringify(buildFhirBundle(c, DEMO_PROFILE))).toBe(
      JSON.stringify(buildFhirBundle(c, DEMO_PROFILE)),
    )
  })

  it('maps the patient with gender and approximate birth year', () => {
    const c = makeCase()
    const [patient] = resources(buildFhirBundle(c, DEMO_PROFILE), 'Patient')
    expect(patient.gender).toBe(DEMO_PROFILE.sex)
    const birthYear = new Date(c.createdAt).getUTCFullYear() - DEMO_PROFILE.age
    expect(patient.birthDate).toBe(String(birthYear))
  })

  it('exports vitals as LOINC-coded Observations with UCUM units', () => {
    const obs = resources(buildFhirBundle(makeCase(), DEMO_PROFILE), 'Observation')
    expect(obs).toHaveLength(7)
    const codes = obs.map((o) => (o.code as { coding: { code: string }[] }).coding[0].code)
    expect(codes).toContain('8480-6') // systolic BP
    expect(codes).toContain('59408-5') // SpO2
    for (const o of obs) {
      const vq = o.valueQuantity as { system: string; value: number }
      expect(vq.system).toBe('http://unitsofmeasure.org')
      expect(typeof vq.value).toBe('number')
    }
  })

  it('omits Observations when the profile belongs to a different patient', () => {
    const c = { ...makeCase(), patientId: 'p_someone_else' }
    const b = buildFhirBundle(c, DEMO_PROFILE)
    expect(resources(b, 'Observation')).toHaveLength(0)
    expect(validateFhirBundle(b)).toEqual([])
  })

  it('exports findings as provisional Conditions with AI confidence', () => {
    const conditions = resources(buildFhirBundle(makeCase(), DEMO_PROFILE), 'Condition')
    expect(conditions.length).toBeGreaterThan(0)
    for (const cond of conditions) {
      const ver = cond.verificationStatus as { coding: { code: string }[] }
      expect(ver.coding[0].code).toBe('provisional')
      const ext = cond.extension as { url: string; valueInteger: number }[]
      expect(ext[0].url).toContain('ai-confidence')
      expect(ext[0].valueInteger).toBeGreaterThan(0)
    }
  })

  it('exports medications, referral, risk assessment and red flags', () => {
    const b = buildFhirBundle(makeCase(), DEMO_PROFILE)
    expect(resources(b, 'MedicationStatement')).toHaveLength(2)
    const [referral] = resources(b, 'ServiceRequest')
    expect(referral.intent).toBe('proposal')
    expect(['routine', 'urgent', 'asap', 'stat']).toContain(referral.priority)
    const [risk] = resources(b, 'RiskAssessment')
    const predictions = risk.prediction as { probabilityDecimal: number }[]
    expect(predictions.length).toBeGreaterThan(0)
    for (const p of predictions) {
      expect(p.probabilityDecimal).toBeGreaterThanOrEqual(0)
      expect(p.probabilityDecimal).toBeLessThanOrEqual(1)
    }
  })

  it('anchors everything in a DiagnosticReport whose references resolve', () => {
    const b = buildFhirBundle(makeCase(), DEMO_PROFILE)
    const [report] = resources(b, 'DiagnosticReport')
    expect(report.status).toBe('preliminary')
    const urls = new Set(b.entry.map((e) => e.fullUrl))
    for (const r of report.result as { reference: string }[]) {
      expect(urls.has(r.reference)).toBe(true)
    }
  })

  it('records AI generation and clinician sign-off as Provenance', () => {
    const c: Case = {
      ...makeCase(),
      doctorNote: {
        doctorId: 'd1',
        doctorName: 'Dr. Kenji Watanabe',
        decision: 'modify',
        note: 'Adjusted confidence on cardiac differential.',
        createdAt: new Date().toISOString(),
      },
    }
    const b = buildFhirBundle(c, DEMO_PROFILE)
    const prov = resources(b, 'Provenance')
    expect(prov).toHaveLength(2)
    const activities = prov.map(
      (p) => (p.activity as { coding: { code: string }[] }).coding[0].code,
    )
    expect(activities).toContain('GENERATE')
    expect(activities).toContain('UPDATE')
    const [report] = resources(b, 'DiagnosticReport')
    expect(report.status).toBe('final')
  })

  it('tags every resource as synthetic test data', () => {
    const b = buildFhirBundle(makeCase(), DEMO_PROFILE)
    for (const e of b.entry) {
      const tags = (e.resource.meta as { tag: { code: string }[] }).tag
      expect(tags.some((t) => t.code === 'HTEST')).toBe(true)
    }
  })
})

describe('validateFhirBundle', () => {
  it('accepts a freshly built bundle', () => {
    expect(validateFhirBundle(buildFhirBundle(makeCase(), DEMO_PROFILE))).toEqual([])
  })

  it('rejects non-bundle payloads', () => {
    expect(validateFhirBundle(null)).toContain('payload is not an object')
    expect(validateFhirBundle({ resourceType: 'Patient' })).toContain(
      'resourceType must be "Bundle"',
    )
  })

  it('catches unresolved internal references', () => {
    const b = buildFhirBundle(makeCase(), DEMO_PROFILE)
    b.entry = b.entry.filter((e) => e.resource.resourceType !== 'Device')
    const issues = validateFhirBundle(b)
    expect(issues.some((i) => i.startsWith('unresolved reference'))).toBe(true)
  })

  it('catches duplicate ids and missing required fields', () => {
    const b = buildFhirBundle(makeCase(), DEMO_PROFILE)
    b.entry[1].resource.id = b.entry[0].resource.id
    delete (b.entry[0].resource as { gender?: string }).gender
    const issues = validateFhirBundle(b)
    expect(issues.some((i) => i.includes('duplicate resource id'))).toBe(true)
    expect(issues.some((i) => i.includes('Patient') && i.includes('gender'))).toBe(true)
  })
})

describe('bundleStats', () => {
  it('counts resources by type', () => {
    const stats = bundleStats(buildFhirBundle(makeCase(), DEMO_PROFILE))
    expect(stats.Patient).toBe(1)
    expect(stats.Observation).toBe(7)
    expect(stats.DiagnosticReport).toBe(1)
  })
})
