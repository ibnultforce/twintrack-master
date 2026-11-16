'use client';

import { useEffect, useRef, useState } from 'react';
import { CLAUDE_CODE_WEB_URL, CLAUDE_WEB_GUIDE, REPOSITORY_COLLABORATORS_URL, REPOSITORY_URL } from '@/lib/claudeWebGuide';

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

/** A side panel for super admins: how to work on this repo from Claude Code on the web, and how to let others work on it. */
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
      <p className="muted">Change, test and deploy TwinTrack from any browser. Only super admins see this.</p>
      <p className="side-panel-links">
        <a href={CLAUDE_CODE_WEB_URL} target="_blank" rel="noreferrer">Open claude.ai/code</a>
        <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">Repository on GitHub</a>
        <a href={REPOSITORY_COLLABORATORS_URL} target="_blank" rel="noreferrer">Collaborators</a>
      </p>
      {CLAUDE_WEB_GUIDE.map((section) => (
        <section key={section.title} className="guide-section" aria-label={section.title}>
          <h3>{section.title}</h3>
          <ol className="guide-steps">
            {section.steps.map((step) => (
              <li key={step.title}>
                <h4>{step.title}</h4>
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
        </section>
      ))}
    </dialog>
  );
}
