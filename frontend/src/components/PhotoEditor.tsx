'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { describeError } from '@/lib/api/http';
import { removeUserPhoto, setUserPhoto } from '@/lib/api/users';
import { PersonPhoto } from './PersonPhoto';
import { Notice } from './ui';

/** The API's limits, checked here first so a wrong file gets a clear answer without uploading it. */
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** Shows a photo and, when allowed, lets it be replaced or removed. */
export function PhotoEditor({ personId, name, photoUpdatedAt, online, canChange, onChanged }: {
  personId: string;
  name: string;
  photoUpdatedAt?: string;
  online?: boolean;
  canChange: boolean;
  onChanged: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);

  const run = async (change: () => Promise<unknown>) => {
    setIsBusy(true);
    setError('');
    try {
      await change();
      onChanged();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setIsBusy(false);
    }
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError('Choose a PNG, JPEG or WebP image.');
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setError('Choose an image of 2 MB or less.');
      return;
    }
    void run(() => setUserPhoto(personId, file));
  };

  return (
    <div className="stack">
      <div className="photo-editor">
        <PersonPhoto personId={personId} name={name} photoUpdatedAt={photoUpdatedAt} online={online} size="large" />
        {canChange ? (
          <div className="actions">
            <input ref={fileInput} className="visually-hidden" type="file" accept={ACCEPTED_TYPES.join(',')} aria-label="Photo file" onChange={upload} />
            <button type="button" className="btn btn-small" disabled={isBusy} onClick={() => fileInput.current?.click()}>{photoUpdatedAt ? 'Change photo' : 'Add photo'}</button>
            {photoUpdatedAt ? <button type="button" className="btn btn-small" disabled={isBusy} onClick={() => void run(() => removeUserPhoto(personId))}>Remove</button> : null}
          </div>
        ) : null}
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}
