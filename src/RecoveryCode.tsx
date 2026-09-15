const today = () => new Date().toISOString().slice(0, 10)

/** Print the recovery code on its own page: a drawer, a safe, the folder with the passports. */
export function printRecoveryCode(code: string) {
  const w = window.open('', '_blank', 'width=560,height=420')
  if (!w) return
  w.document.write(
    `<title>Scarab recovery code</title><body style="font-family:system-ui;padding:32px;color:#111">` +
      `<h2 style="margin:0 0 6px">Scarab vault — recovery code</h2>` +
      `<p style="margin:0 0 18px;color:#555">Printed ${today()}. Opens the vault without a passkey. There is no reset: keep this somewhere real.</p>` +
      `<pre style="font:18px/1.6 ui-monospace,monospace;letter-spacing:1px;white-space:pre-wrap">${code.replace(/(.{24})-/g, '$1-\n')}</pre></body>`,
  )
  w.document.close()
  w.focus()
  w.print()
}

/** The one place the raw data key is ever shown. */
export default function RecoveryCode({ code, title, onDone }: { code: string; title: string; onDone: () => void }) {
  return (
    <div className="recovery">
      <div className="h4row">
        <b className="inkstrong">{title}</b>
        <div className="right muted">write it down · it will not be shown again unprompted</div>
      </div>
      <pre className="recoverycode">{code}</pre>
      <p className="sub2">
        This code alone opens the vault, on any device, without a passkey. Zero-knowledge means nobody can reset it
        for you: lose every passkey and this code, and the vault is gone.
      </p>
      <div className="formrow">
        <button className="btn" onClick={() => printRecoveryCode(code)}>Print</button>
        <button className="btn ghosty" onClick={() => navigator.clipboard?.writeText(code)}>Copy</button>
        <button className="btn gold" onClick={onDone}>I've stored it</button>
      </div>
    </div>
  )
}
