import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { ImageIcon } from '@/components/icons';

/**
 * Render an item thumbnail from its stored BLOB bytes (spec §4.2.4) via a transient
 * object URL, revoked on cleanup. Falls back to a placeholder glyph when absent.
 * Only ever handed the tiny thumbnail — the full-res image is read from OPFS lazily.
 *
 * The object URL is created in an effect (not during render) and held in state, so
 * the committed `<img>` only ever references a still-live URL — avoiding the
 * StrictMode double-invoke revoking a URL the DOM is mid-load on.
 */
export function Thumbnail({
  bytes,
  alt,
  className,
}: {
  bytes: Uint8Array | null | undefined;
  alt: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!bytes || bytes.byteLength === 0) {
      setUrl(null);
      return;
    }
    // Copy into a fresh ArrayBuffer: BLOBs can arrive SharedArrayBuffer-backed from
    // the OPFS worker, which the Blob constructor will not accept.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const objectUrl = URL.createObjectURL(new Blob([copy.buffer], { type: 'image/webp' }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [bytes]);

  if (!url) {
    return (
      <div className={cn('grid place-items-center text-muted-foreground [&_svg]:size-5', className)}>
        <ImageIcon />
      </div>
    );
  }
  return <img src={url} alt={alt} className={cn('object-cover', className)} />;
}
