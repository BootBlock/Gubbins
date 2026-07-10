import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Banner, buttonVariants } from '@/components/foundry';
import { CloudUploadIcon, DatabaseIcon, FolderSyncIcon, InfoIcon, SuccessIcon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { hasFileSystemAccess } from '@/lib/env/feature-detection';
import { CommandBlock, ChoiceCards, BranchPanel, StepCard } from '../components';
import { useGuide, tokenForDisplay } from '../context';

type DataPath = 'folder' | 'push' | 'sqlite';

/**
 * Step 4 — get your inventory to the bridge.
 *
 * The bridge answers from a copy of your data; this step branches on *how* that copy reaches
 * it. A synced folder is the recommended, cross-device default; a direct push suits users with
 * no shared folder; a raw `.sqlite` export is the read-only fallback. Whichever they pick, the
 * bridge auto-detects the source, so the rest of the guide is identical.
 */
export function DataStep() {
  const { token } = useGuide();
  const displayToken = tokenForDisplay(token);
  const [path, setPath] = useState<DataPath | null>(null);
  // Folder sync needs the File System Access API — Chromium-only (Chrome/Edge/Opera). When it is
  // absent (Firefox/Safari) we steer the reader to the browser-agnostic paths instead of a dead end.
  const fsSupported = hasFileSystemAccess();

  return (
    <div className="space-y-6">
      <StepCard title="How your data reaches the bridge" icon={<DatabaseIcon />}>
        <p className="text-sm text-muted-foreground">
          The bridge needs a copy of your inventory to answer questions. There are three ways to give it one —
          pick whichever fits how you already use Gubbins. The bridge{' '}
          <span className="text-foreground">auto-detects</span> which you chose, and re-reads the data
          automatically whenever it changes, so you set this up once.
        </p>
        <Banner tone="info" icon={<InfoIcon />}>
          Gubbins keeps its data separately in each browser (and each install), so run the sync or export
          below from the browser that already holds your inventory — otherwise the bridge will see an empty
          library.
        </Banner>
      </StepCard>

      <ChoiceCards
        legend="Which way suits you?"
        columns={3}
        value={path}
        onChange={setPath}
        options={[
          {
            id: 'folder',
            title: 'Synced folder',
            description: 'Recommended. You already sync Gubbins to a folder.',
            Icon: FolderSyncIcon,
          },
          {
            id: 'push',
            title: 'Push from the app',
            description: 'No shared folder — send data straight to the bridge.',
            Icon: CloudUploadIcon,
          },
          {
            id: 'sqlite',
            title: 'Raw database export',
            description: 'A one-off exported .sqlite file (read-only).',
            Icon: DatabaseIcon,
          },
        ]}
      />

      {path === 'folder' ? (
        <BranchPanel>
          <StepCard title="Use a synced folder">
            {!fsSupported ? (
              <Banner tone="warning" icon={<InfoIcon />} heading="This browser can't sync to a folder">
                Folder sync uses the File System Access API, which only Chromium browsers (Chrome, Edge,
                Opera) provide — Firefox and Safari don't. In those, choose{' '}
                <span className="text-foreground">Push from the app</span> or{' '}
                <span className="text-foreground">Raw database export</span> above instead.
              </Banner>
            ) : null}
            <p className="text-sm text-muted-foreground">
              Gubbins can sync to a folder you control (e.g. one inside a cloud-drive mount, a NAS share, or a
              synced drive). That folder holds a{' '}
              <code className="rounded bg-secondary/60 px-1">gubbins-sync.json</code> file — exactly what the
              bridge reads.
            </p>
            <ol className="ml-4 list-decimal space-y-2 text-sm text-muted-foreground">
              <li>
                Open <span className="text-foreground">Cloud Sync &amp; backups</span> and connect a local
                folder that the bridge machine can also see.
              </li>
              <li>Run a sync so the folder gets a fresh snapshot.</li>
              <li>
                Point the bridge's <code className="rounded bg-secondary/60 px-1">GUBBINS_SNAPSHOT_PATH</code>{' '}
                at that file.
              </li>
            </ol>
            <div>
              <Link to="/sync" className={cn(buttonVariants({ variant: 'outline' }))}>
                <FolderSyncIcon />
                Open Cloud Sync &amp; backups
              </Link>
            </div>
            <Banner tone="info" icon={<InfoIcon />}>
              This is the recommended path because it's a two-way channel: it also enables the optional
              check-in / check-out writes later, if you ever want them.
            </Banner>
          </StepCard>
        </BranchPanel>
      ) : path === 'push' ? (
        <BranchPanel>
          <StepCard title="Push straight to the bridge">
            <p className="text-sm text-muted-foreground">
              No NAS or synced drive? The app can send your whole dataset to the bridge over your network. You
              enable this on the bridge with one setting, then push from the Cloud Sync screen.
            </p>
            <p className="text-sm text-muted-foreground">
              First, add this to the bridge's env and restart it:
            </p>
            <CommandBlock label="enable push setting" code={`GUBBINS_BRIDGE_ALLOW_PUSH=on`} />
            <p className="text-sm text-muted-foreground">
              Then open Cloud Sync, fill in the bridge <span className="text-foreground">URL</span> and{' '}
              <span className="text-foreground">token</span> under "Push to bridge", and press{' '}
              <span className="text-foreground">Push now</span>.
            </p>
            <div>
              <Link to="/sync" className={cn(buttonVariants({ variant: 'outline' }))}>
                <CloudUploadIcon />
                Open "Push to bridge"
              </Link>
            </div>
            <p className="text-xs text-muted-foreground">
              With a push source, the bridge doesn't need{' '}
              <code className="rounded bg-secondary/60 px-1">GUBBINS_SNAPSHOT_PATH</code> to point at a shared
              folder — it writes the pushed data to that path itself.
            </p>
          </StepCard>
        </BranchPanel>
      ) : path === 'sqlite' ? (
        <BranchPanel>
          <StepCard title="Use a raw database export">
            <p className="text-sm text-muted-foreground">
              If you'd rather not sync, you can export the whole database from Gubbins and point the bridge at
              that file. Set <code className="rounded bg-secondary/60 px-1">GUBBINS_SNAPSHOT_PATH</code> to
              the <code className="rounded bg-secondary/60 px-1">.sqlite</code> file — the bridge detects it
              and opens a private copy (it never locks or changes your export).
            </p>
            <Banner tone="warning" icon={<InfoIcon />} heading="Read-only, and manual to refresh">
              A raw export is a point-in-time copy: the bridge can't write back to it, and it won't update
              until you export again and replace the file. For live data, prefer a synced folder or push.
            </Banner>
          </StepCard>
        </BranchPanel>
      ) : null}

      {path ? (
        <StepCard title="Check the bridge can see your data" icon={<SuccessIcon />}>
          <p className="text-sm text-muted-foreground">
            Once the data is in place and the bridge is running, ask it how many items it can see. Run this
            from any machine on your network (adjust the host if the bridge isn't local):
          </p>
          <CommandBlock
            label="health-check command"
            code={`curl -H "Authorization: Bearer ${displayToken}" "http://127.0.0.1:8787/health"`}
          />
          <p className="text-sm text-muted-foreground">
            You want a reply like{' '}
            <code className="rounded bg-secondary/60 px-1">{`{"ok":true,"itemCount":42,…}`}</code>. If{' '}
            <code className="rounded bg-secondary/60 px-1">itemCount</code> is{' '}
            <span className="text-foreground">0</span>, the bridge started but hasn't got your data yet —
            re-run the sync/push, or double-check the snapshot path. A{' '}
            <code className="rounded bg-secondary/60 px-1">401</code> means the token doesn't match; a
            connection error means the bridge isn't running or the host is wrong.
          </p>
        </StepCard>
      ) : null}
    </div>
  );
}
