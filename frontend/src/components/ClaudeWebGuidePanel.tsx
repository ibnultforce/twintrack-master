'use client';

import { useEffect, useRef, useState } from 'react';
import { CLAUDE_CODE_WEB_URL, CLAUDE_WEB_SETUP_STEPS, REPOSITORY_URL } from '@/lib/claudeWebGuide';

function CopyButton({ text }: { text: string }) {
  const [label, setLabel] = useState('Copy');
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => setLabel('Copied'),
      () => setLabel('Copy it by hand'),
    );
  };
  return <button type="button" className="btn btn-small" onClick={copy}>{label}</button>;
}

/** A side panel for super admins: how to set up, test and screenshot this repo from Claude Code on the web. */
export function ClaudeWebGuidePanel({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog ref={dialogRef} className="side-panel" aria-labelledby="claude-guide-title" onCancel={onClose}>
      <div className="side-panel-head">
        <h2 id="claude-guide-title">Claude Code on the web</h2>
        <button type="button" className="btn btn-small" onClick={onClose}>Close</button>
      </div>
      <p className="muted">Set up, test and screenshot TwinTrack from any computer. Only super admins see this.</p>
      <p className="side-panel-links">
        <a href={CLAUDE_CODE_WEB_URL} target="_blank" rel="noreferrer">Open claude.ai/code</a>
        <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">Repository on GitHub</a>
      </p>
      <ol className="guide-steps">
        {CLAUDE_WEB_SETUP_STEPS.map((step) => (
          <li key={step.title}>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
            {step.prompt ? (
              <div className="guide-prompt">
                <pre>{step.prompt}</pre>
                <CopyButton text={step.prompt} />
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </dialog>
  );
}
