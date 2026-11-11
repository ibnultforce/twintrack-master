'use client';

import { useEffect, useState } from 'react';
import { getUserPhoto } from '@/lib/api/users';
import { initials } from '@/lib/format';

/**
 * Photos need the access token, so they're fetched and shown from memory. Each photo version is fetched once per page
 * load, however many times it appears, and a new upload changes photoUpdatedAt, which fetches the new one.
 */
const photoUrls = new Map<string, Promise<string | null>>();

function loadPhotoUrl(personId: string, photoUpdatedAt: string): Promise<string | null> {
  const key = `${personId}@${photoUpdatedAt}`;
  let url = photoUrls.get(key);
  if (!url) {
    // A photo that fails to load falls back to initials, which is always a fine way to show someone.
    url = getUserPhoto(personId).then((blob) => URL.createObjectURL(blob), () => null);
    photoUrls.set(key, url);
  }
  return url;
}

/** Someone's photo, or their initials when they have none. The dot shows online status where the viewer may see it. */
export function PersonPhoto({ personId, name, photoUpdatedAt, online, size = 'small' }: {
  personId: string;
  name: string;
  photoUpdatedAt?: string;
  online?: boolean;
  size?: 'small' | 'large';
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!photoUpdatedAt) {
      setUrl(null);
      return undefined;
    }
    let isCurrent = true;
    void loadPhotoUrl(personId, photoUpdatedAt).then((loaded) => {
      if (isCurrent) setUrl(loaded);
    });
    return () => {
      isCurrent = false;
    };
  }, [personId, photoUpdatedAt]);

  return (
    <span className={`photo photo-${size}`}>
      {/* A file the browser can't show falls back to initials too. */}
      {url ? <img src={url} alt="" onError={() => setUrl(null)} /> : <span className="avatar" aria-hidden="true">{initials(name)}</span>}
      {online === undefined ? null : (
        <span className={`online-dot ${online ? 'is-online' : ''}`} role="img" aria-label={online ? 'Online' : 'Offline'} />
      )}
    </span>
  );
}
