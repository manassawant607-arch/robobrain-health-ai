import { useMemo, useState } from 'react'
import type { Case } from '@/types'
import { buildFhirBundle, bundleStats, validateFhirBundle } from '@/lib/fhir'
import { useAppState } from '@/lib/store'
import { Icon } from './Icon'
import { Card, SectionTitle } from './ui'

const PREVIEW_LINES = 60

/**
 * Clean Data Exchange — hands a case to the outside world as a validated
 * HL7 FHIR R4 bundle (EHR / HIE / JP Core compatible), with a structural
 * validation report so the receiving system never gets a broken payload.
 */
export function DataExchange({ caseData }: { caseData: Case }) {
  const { profile } = useAppState()
  const [showPreview, setShowPreview] = useState(false)
  const [copied, setCopied] = useState(false)

  const { bundle, issues, stats, json } = useMemo(() => {
    const b = buildFhirBundle(caseData, profile.id === caseData.patientId ? profile : undefined)
    return {
      bundle: b,
      issues: validateFhirBundle(b),
      stats: bundleStats(b),
      json: JSON.stringify(b, null, 2),
    }
  }, [caseData, profile])

  const download = () => {
    const blob = new Blob([json], { type: 'application/fhir+json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `robobrain-${caseData.id}.fhir.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard unavailable (permissions / non-secure context) */
    }
  }

  const statLine = Object.entries(stats)
    .map(([type, n]) => `${type} ×${n}`)
    .join(' · ')

  const previewLines = json.split('\n')
  const preview =
    previewLines.length > PREVIEW_LINES
      ? `${previewLines.slice(0, PREVIEW_LINES).join('\n')}\n  … (${previewLines.length - PREVIEW_LINES} more lines)`
      : json

  return (
    <Card>
      <SectionTitle
        icon="FileJson"
        title="Clean Data Exchange"
        subtitle="HL7 FHIR R4 bundle — interoperable with EHRs, HIE gateways and JP Core (Japan) systems"
        action={
          <span className="chip bg-brand-50 text-brand-700">
            <Icon name="Globe" size={13} /> FHIR R4
          </span>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" onClick={download}>
          <Icon name="Download" size={15} /> Download FHIR JSON
        </button>
        <button className="btn-outline" onClick={copy}>
          <Icon name={copied ? 'Check' : 'Copy'} size={15} /> {copied ? 'Copied!' : 'Copy JSON'}
        </button>
        <button className="btn-ghost" onClick={() => setShowPreview((v) => !v)}>
          <Icon name={showPreview ? 'EyeOff' : 'Eye'} size={15} />
          {showPreview ? 'Hide preview' : 'Preview bundle'}
        </button>
      </div>

      {issues.length === 0 ? (
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">
          <Icon name="ShieldCheck" size={16} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-bold">Valid bundle</span> — {bundle.entry.length} resources (
            {statLine}). Every internal reference resolves; required fields present.
          </span>
        </div>
      ) : (
        <div className="mt-3 rounded-xl bg-red-50 p-3 text-sm text-red-800">
          <div className="flex items-center gap-2 font-bold">
            <Icon name="ShieldAlert" size={16} /> {issues.length} validation issue
            {issues.length > 1 ? 's' : ''}
          </div>
          <ul className="mt-1 list-inside list-disc">
            {issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      {showPreview && (
        <pre className="mt-3 max-h-96 overflow-auto rounded-xl bg-ink-900 p-4 text-xs leading-relaxed text-emerald-100">
          {preview}
        </pre>
      )}

      <p className="mt-3 text-xs text-ink-400">
        Resources are tagged as synthetic test data (HTEST) so receiving systems never confuse
        demo output with real PHI. Provenance entries record both AI generation and clinician
        sign-off for a complete audit trail.
      </p>
    </Card>
  )
}
