# **Hardware & Inventory Tracking System Specification**

## **1\. Introduction**

This document serves as the absolute specification and implementation guide for an AI agent (e.g., Opus 4.8) to construct a highly flexible, extensible web application for tracking electronic components, 3D printing supplies, tools, and general inventory.

### **1.1 Core Principles**

* **No Monolithic Files:** Code must be highly modular, separated by domain and responsibility.  
* **No God Objects:** Avoid massive classes or overarching state managers that know too much.  
* **Avoid YAGNI (You Aren't Gonna Need It):** Implement strictly what is specified for each phase. Build extensible interfaces, but do not implement unused features prematurely.  
* **British English:** All user-facing text, UI elements, and documentation must strictly use British English spelling and grammar (e.g., categorise, synchronisation, colour, behaviour).  
* **Strict Phasing:** Every phase must be completed and pass a simulated or actual code review before the agent proceeds to the next.  
* **Premium & Engaging Aesthetic (Non-Enterprise):** The application must actively avoid the dry, utilitarian, spreadsheet-like look of typical enterprise software. The UI should be "cutting-edge," visually striking, and genuinely fun to use. It must mimic high-end consumer products or modern developer tools (e.g., Linear, Vercel), prioritising a polished, highly interactive, and satisfying user experience.

### **1.2 Resolved Clarifications & Locked Decisions**

*The following implementation decisions were resolved with the human developer on 2026-06-27, prior to Phase 1, to remove architectural ambiguity that would otherwise risk structural debt. They are **binding for all subsequent phases** and must be restated in every PHASE\_HANDOVER.md (Protocol Alpha, §8.1). Where a decision refines an option the specification deliberately left open, the governing section is cited.*

* **Project Name:** The application is named **Gubbins**.
* **SQLite WASM Distribution (refines §2.2.1a):** The project must use the **official @sqlite.org/sqlite-wasm** distribution. It bundles the FTS5 extension by default and provides the standard OPFS VFS that coordinates via SharedArrayBuffer, directly satisfying the COOP/COEP mandate (§2.2.6). The wa-sqlite alternative is **rejected** for Gubbins. The Phase 1 agent must nonetheless explicitly verify FTS5 availability at runtime (e.g. a startup `PRAGMA compile\_options;` / FTS5 smoke test) per the §2.2.1a compilation-trap warning, failing loudly if absent.
* **Package Manager:** **npm**. All install instructions, the committed lockfile (`package-lock.json`), and `package.json` scripts must assume npm. Competing lockfiles (pnpm/yarn/bun) must not be introduced.
* **Production Hosting Target (binds §2.2.6):** **GitHub Pages** (static hosting). The following consequences are therefore locked:
  * Vite must be configured with `base: '/Gubbins/'`.
  * Production cross-origin isolation must be delivered via the **coi-serviceworker** polyfill (injecting `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`), since GitHub Pages cannot set custom response headers. The Vite **dev server** must additionally set these headers directly (§2.2.6) so local OPFS development is cross-origin isolated.
  * The TanStack Router configuration and the PWA manifest `scope` / `start\_url` must respect the `/Gubbins/` base path.
* **Cloud Sync Provider (refines §2 & §7):** **Provider-agnostic by design.** Phase 1 commits to **no** concrete provider. A strict `CloudProvider` interface (to be consumed by `useAuthStore` and the §2 "Initial Handshake" wizard) shall be defined only when first required, with the concrete adapter implemented in Phase 7. No provider SDK may be added to the dependency tree before Phase 7.

#### **1.2.1 Derived Defaults (Not Separately Polled)**

*The following follow logically from the decisions above and from the specification's own stated preferences. They are recorded here for transparency and may be revised if the human developer objects.*

* **Test Runner:** **Vitest** (pairs natively with Vite; listed first in §8.2 / §8.5). Jest must not be introduced.
* **OPFS VFS Strategy:** The official worker-hosted OPFS VFS (`sqlite3.oo1.OpfsDb` / the OPFS access-handle VFS), **not** the SAHPool VFS, consistent with the SharedArrayBuffer coordination mandated in §2.2.6.
* **Base Currency / Locale Default:** **GBP** with an **en-GB** locale as the initial default (remaining user-configurable per §3), consistent with the British English mandate (§1.1).
* **Version Control:** A **git** repository shall be initialised at the project root to satisfy the autonomous rollback procedures of Protocol Delta (§8.4).
* **End-to-End Browser Testing:** **Playwright** (a **dev-only** dependency) driving the *system-installed* browser — Edge via `channel: 'msedge'` — so **no bundled-browser binary is downloaded**. This complements, and does not replace, the Vitest/`:memory:` unit tests of §8.5: it exercises the *real* OPFS + SharedArrayBuffer + Web Worker path those deliberately bypass, against a live dev server (whose COOP/COEP headers supply the cross-origin isolation §2.2.6 requires). Introduced in Phase 2; see §8.5.5.

## **2\. Structural & Fundamental Architecture**

* **Target Environment:** Pure client-side Progressive Web App (PWA). Must support installation to Home Screen/Desktop, offline-first capabilities via Service Workers, and responsive design (Desktop and Mobile).  
* **Architecture:** Local-First. Data resides and is processed entirely within the user's browser/device.  
* **Language:** TypeScript.  
* **Frontend Framework:** React (with Tailwind CSS \+ modern accessible UI components).  
* **Database:** Client-side WebAssembly SQL (e.g., SQLite WASM).  
  * *Full-Text Search:* The SQLite database must be compiled with the **FTS5 extension** to enable robust fuzzy matching, stemming, and tokenisation for text searches.  
* **Data Persistence & Synchronisation:**  
  1\. **File System API:** Auto-saving to a designated local SQLite/JSON file.  
  2\. **Cloud Integration:** Optional cloud sync requiring an **Explicit "Initial Handshake"** setup wizard to authorise via simple API key storage (managed within the Tier 2 Zustand state) and map the storage directory.  
  3\. **Storage Safeguards:**  
  * **Explicit Persistence Request:** The application must execute the navigator.storage.persist() API during the initial setup. If this returns false, the UI must display a persistent warning informing the user their data is considered "ephemeral" by the browser and prompting them to add the PWA to their Home Screen or enable Cloud Sync immediately.  
  * **Mobile Eviction Warning:** The application must display a persistent warning banner on mobile prompting Cloud Sync setup to mitigate browser eviction.  
  * **Hard Stop & Safeguard:** The application must actively monitor storage limits. If a transaction risks breaching the quota, it must perform a graceful "Hard Stop", rolling back the transaction and alerting the user, rather than corrupting the local file.  
  4. **Conflict Resolution:** Strictly **"Last Write Wins"** at the row level for simplicity and speed.  
  5. **Manual Exports:** Explicit "Export" and "Import" backup options. **Crucially**, to prevent catastrophic schema mismatches when moving between devices, full database backups must be generated as a **Versioned JSON File** (e.g., inventory\_backup\_v1.json) that mirrors the LWW Sync Payload, rather than exporting raw .sqlite binaries.  
  6. **Security:** Data is stored unencrypted at rest to prioritise hobbyist accessibility and scripting.  
  7. **Mobile-First Fallback Backups:** Because the File System Access API is unsupported on iOS/Android, the system must employ a JSZip (or fflate) Web Worker fallback. For mobile users without active Cloud Sync, the application must present a weekly prompt to trigger an automated "Full Archive Download", which packages the OPFS SQLite binary and OPFS images into a standard .zip file saved to the device's native Downloads folder.

### **2.1 State Management Strategy & Separation of Concerns**

To ensure high performance and prevent the creation of a monolithic "God Object", the AI agent must strictly adhere to a three-tiered state management architecture. **The SQLite WASM database is the absolute Single Source of Truth (SSOT) for all inventory data.** React state must never duplicate the entire database.

#### **Tier 1: Data State & Caching (TanStack Query)**

* **Tool:** TanStack Query (formerly React Query).  
* **Role:** Acts as the bridge between React components and the asynchronous SQLite WASM worker.  
* **Behaviour:**  
  * All database queries (fetching items, locations, history) must be wrapped in custom hooks (e.g., useInventoryItems(filters), useLocationTree()).  
  * TanStack Query will handle the caching, background refetching, and cache invalidation.  
  * **Strict RPC Pagination & Virtualisation:** To prevent IPC bottlenecks across the Web Worker bridge, the agent is strictly prohibited from returning unpaginated arrays (e.g., ItemRepository.getAll() is forbidden). Query hooks must utilise cursor-based or offset pagination enforcing strict LIMIT and OFFSET clauses at the SQL level, returning chunks of maximum 100 rows. These feed incrementally into the virtualised lists (@tanstack/react-virtual), keeping the DOM and JavaScript heap extremely light even with 100,000+ records.  
  * **Mandatory Optimistic Updates with Rollback:** Database writes (Creates, Updates, Deletes) must trigger targeted cache invalidation rather than requiring a full page reload or manual state synchronisation. To prevent Optimistic UI tearing during rapid successive inputs (which queue in the OPFS), the agent must utilise TanStack Query's onMutate callback. The frontend must immediately assume the write is successful, applying a temporary UUID to the local cache. Crucially, the agent must implement the onError rollback function to revert the specific TanStack cache slice if the Web Worker queue rejects the transaction.

#### **Tier 2: Global UI State (Zustand)**

* **Tool:** Zustand.  
* **Role:** Managing persistent, application-wide user preferences, API credentials, and UI layout toggles.  
* **Behaviour:**  
  * Must be split into discrete, domain-specific stores. Do **not** create one massive useStore.  
  * **Examples of allowed Zustand stores:**  
    * useLayoutStore: Manages the "Data-Heavy" vs "Visual-Heavy" toggle, sidebar collapse state, and dashboard widget layout coordinates.  
    * usePreferencesStore: Manages the selected Base Currency, locale settings, and theme (Dark/Light).  
    * useAuthStore: Manages the simple API key storage required for the explicit handshake cloud provider.  
  * State in this tier should be automatically synced to localStorage (or a dedicated DB settings table) to persist between sessions.

#### **Tier 3: Feature-Specific Ephemeral State (React Context & Hooks)**

* **Tool:** React.useState, React.useReducer, and React.Context.  
* **Role:** Managing complex, deeply nested state that is strictly isolated to a specific feature or workflow.  
* **Behaviour:**  
  * **The Visual Builder:** The complex abstract syntax tree (AST) of the visual search query is highly ephemeral. It must live inside a SearchBuilderContext that is mounted and unmounted with the component, preventing memory leaks when navigating away.  
  * **Mobile Scanner Queue:** The "Continuous Checkout" mode requires a local array of scanned items waiting for confirmation. This lives in a local reducer/context attached strictly to the scanner module overlay, isolated from the rest of the app.

#### **2.1.1 The Repository Pattern Constraint**

React components must **never** write raw SQL queries. The agent must implement a Repository Pattern layer (e.g., ItemRepository.ts, LocationRepository.ts) that encapsulates all SQL string generation and execution. The React components simply call asynchronous methods like ItemRepository.updateQuantity(id, newQuantity) via TanStack Query mutations.

### **2.2 SQLite WASM & OPFS Worker Orchestration (Phase 1 Deep Dive)**

To ensure the application remains perfectly fluid whilst querying 100,000+ records, the agent must strictly adhere to the following database orchestration architecture. Running SQLite on the main thread or using legacy browser storage is strictly forbidden.

#### **2.2.1 Origin Private File System (OPFS) Mandate**

* **The VFS Requirement:** The SQLite WASM instance must be configured to strictly utilise the Origin Private File System (OPFS) as its Virtual File System (VFS).  
* **Forbidden Fallbacks:** The agent must *never* configure the database to use IndexedDB or LocalStorage for the primary item tables, as the I/O bottleneck will cripple the application's performance. Memory-only (:memory:) databases are also forbidden except strictly within automated test suites.

#### **2.2.1a The OPFS \+ FTS5 Compilation Trap**

* **Explicit Distribution Requirement:** Standard, pre-compiled NPM packages for SQLite WASM do not always bundle the FTS5 extension by default alongside the OPFS VFS drivers. If left unspecified, the agent may hallucinate a generic import sqlite3 that silently drops full-text search capabilities, causing the Visual Builder to crash in later phases. The agent must strictly utilise a distribution explicitly compiled with *both* (e.g., wa-sqlite configured with the FTS5 build variant, or the official @sqlite.org/sqlite-wasm if explicitly verifying FTS5 inclusion) and define this instantiation correctly during Phase 1\.

#### **2.2.2 Web Worker Isolation**

* **Total Separation:** The database initialisation, connection pool, and all SQL execution contexts must reside entirely within a dedicated Web Worker (e.g., database.worker.ts).  
* **The Main Thread Rule:** React components and the main thread are strictly prohibited from importing the SQLite WASM binary directly.

#### **2.2.3 The RPC Bridge & Repository Layer**

* **Communication:** To facilitate communication between the React main thread and the isolated database worker, the agent must implement a strongly typed Remote Procedure Call (RPC) bridge. The agent may use a library like Comlink or build a robust, promise-based postMessage wrapper.  
* **Repository Integration:** The Repository layer (described in Section 2.1.1) sits on the main thread and acts as the client to this RPC bridge. When ItemRepository.getPaginated(limit, offset) is called, it passes the parameterised request over the bridge, the worker executes the SQL, and the resulting restricted array chunk is marshalled back to the main thread.

#### **2.2.4 Concurrency & Lock Management**

* **Exclusive Write Locks:** Because the OPFS API enforces exclusive write locks on files, the database worker must implement an internal queuing mechanism for incoming INSERT, UPDATE, and DELETE transactions.  
* **Error Prevention:** This queue ensures rapid, successive user actions (e.g., scanning 10 items in Continuous Mode) do not trigger SQLITE\_BUSY or SQLITE\_LOCKED crash states within the worker.

#### **2.2.5 Future-Proofing: Agentic API Bridge**

* **Roadmap Task:** While isolated within the OPFS for security, the architecture must anticipate future integration with external local agents (e.g., Voice Dictation or Command & Control suites like SpectraWrite). The worker orchestration layer should be structured to easily support exposing a strict, authenticated WebSocket or local HTTP listener (potentially via a companion native host messaging script) in future phases. This will allow external commands (e.g., *"Check out one ESP32 to the workbench"*) to safely interact with the PWA's repository layer.

#### **2.2.6 The COOP/COEP Header Mandate**

* **Cross-Origin Isolation:** The official, high-performance SQLite OPFS VFS relies on SharedArrayBuffer to coordinate synchronous blocking between the Web Worker and the file system. Modern browsers strictly block SharedArrayBuffer unless the serving environment is isolated.  
* **Server Configuration:** The agent must configure the development server (e.g., vite.config.ts) with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp headers.  
* **Production Deployment:** For static production hosting (e.g., GitHub Pages), the agent must include a Service Worker polyfill (such as coi-serviceworker) to dynamically inject these headers, preventing silent OPFS mount errors in production.

#### **2.2.7 Multi-Tab Concurrency Guard**

* **Lock Prevention:** OPFS enforces an exclusive write lock. If a user opens the PWA in two separate browser tabs, the second tab will fail to mount the SQLite database and gracefully crash.  
* **Implementation:** The agent must implement a BroadcastChannel or Web Locks API check upon initial application startup. If another tab already holds the database lock, the UI must immediately display a graceful "Application is open in another tab" overlay, preventing untrapped SQL errors and protecting data integrity.

### **2.3 Client-Side Schema Migrations (Phase 2+ Deep Dive)**

As the application advances through implementation phases, the database schema will inevitably evolve (e.g., adding new tracking columns or relation tables). SQLite has notoriously limited ALTER TABLE capabilities. To prevent the agent from attempting destructive workarounds that drop existing user data, it must strictly implement a versioned Migration Engine.

#### **2.3.1 PRAGMA user\_version Tracking**

* **Native Versioning:** The SQLite database must internally track its current schema state using the native PRAGMA user\_version command.  
* **No Guesswork:** The agent is strictly forbidden from querying sqlite\_master to guess if a column exists on the fly. All schema state is dictated absolutely by the integer value of user\_version.

#### **2.3.2 The Migration Engine**

* **Startup Orchestration:** Upon initialising the Web Worker (Section 2.2), the database orchestration layer must immediately check the user\_version.  
* **Sequential Execution:** If the internal version is lower than the application's target version, the engine must execute a strict sequence of immutable migration scripts (e.g., v1\_to\_v2, v2\_to\_v3) until the database is up to date.  
* **Atomicity:** Each discrete migration step must be wrapped entirely within a BEGIN TRANSACTION; ... COMMIT; block. If a migration fails, it must automatically ROLLBACK and halt the application with an error, rather than leaving the database in a corrupted partial state.

#### **2.3.3 The Safe Table Recreation Pattern**

When a schema change exceeds SQLite's basic ALTER TABLE ADD COLUMN capabilities (e.g., altering a column type, dropping a column, or adding a strict foreign key), the agent must autonomously implement the official SQLite 12-Step Table Alteration pattern within its migration script.  
The agent must script the following exact sequence:

1. BEGIN TRANSACTION;  
2. CREATE TABLE new\_target\_table (...); (with the updated schema)  
3. INSERT INTO new\_target\_table SELECT ... FROM old\_target\_table; (mapping the preserved data)  
4. DROP TABLE old\_target\_table;  
5. ALTER TABLE new\_target\_table RENAME TO old\_target\_table;  
6. Recreate any necessary indexes or triggers attached to the table.  
7. PRAGMA user\_version \= new\_version;  
8. COMMIT;

Under no circumstances is the agent permitted to execute a raw DROP TABLE without a prior data-preservation INSERT step during a migration.

### **2.4 Strict Dependency & Tooling Matrix**

To prevent dependency sprawl, AI hallucination of incompatible libraries, and bloated bundles, the agent must strictly adhere to the following tooling matrix. Arbitrary deviation or the installation of overlapping libraries is strictly forbidden.

#### **2.4.1 The UI Primitive & Styling Baseline**

* **Styling Framework:** The agent must exclusively use **Tailwind CSS** for all styling, relying on utility classes to manage layout, typography, and colour. Bespoke CSS files or CSS-in-JS libraries (e.g., styled-components, Emotion) are prohibited.  
  * **Cutting-Edge Visuals Mandate:** The agent is explicitly instructed to push Tailwind's capabilities to deliver a "flashy," cutting-edge visual experience. This includes leveraging fluid CSS transitions, subtle glassmorphism (backdrop blurs), modern gradient accents, deep and satisfying dark-mode palettes, playful hover states, and refined drop-shadows. The styling must feel extremely premium.  
* **Component Architecture & Abstraction Layer:** The agent must strictly use **shadcn/ui** for accessible UI primitives, installed directly into the codebase. However, feature components must **never** import these directly. The agent must implement an abstraction layer (e.g., components/core or components/foundry) that exports these underlying primitives. All feature components must import from this internal registry. This guarantees the ability to transparently swap out standard primitives for custom-optimised controls later without refactoring the application.  
* **Iconography:** The agent must exclusively use **lucide-react** for all application icons, similarly abstracting them through a central icon registry. Hallucinating alternative icon libraries (such as FontAwesome or Heroicons) is not permitted. Heavy, overarching component libraries such as Material UI (MUI), Chakra UI, or Ant Design are strictly forbidden to prevent bundle bloat and rigid enterprise aesthetics.

#### **2.4.2 The Routing Architecture**

* **Client-Side Routing:** The application must utilise a robust, pure client-side routing solution to navigate between the Dashboard, Item Profiles, and Scanner modules without triggering full page reloads.  
* **Mandated Router:** The agent must exclusively implement **TanStack Router**. This guarantees strict type-safe routing that integrates seamlessly with our existing Tier 1 state management (TanStack Query).  
* **Forbidden Frameworks:** The agent is strictly prohibited from attempting to migrate the application to server-side rendering (SSR) or overarching meta-frameworks such as Next.js or Remix. These fundamentally violate the local-first, offline-first architecture of the PWA.

#### **2.4.3 Native API Preference vs. NPM Bloat**

* **Prioritise Web APIs:** To maintain a lean bundle size and reduce the vulnerability surface area, the agent must ruthlessly prioritise modern native browser APIs over external NPM packages.  
* **UUID Generation:** For generating UUIDv4 strings (critical for the Last Write Wins sync engine), the agent must strictly use the native crypto.randomUUID() method. Installing external packages such as uuid or uuidv4 is strictly forbidden.  
* **Formatting & Audio:** The agent must utilise native solutions such as Intl.NumberFormat for all currency and date formatting, and the native Web Audio API for scanner feedback beeps, rather than importing third-party formatting or audio libraries.

#### **2.4.4 Strict Schema Validation & Form Tooling**

* **Data Validation:** To prevent injection of invalid data types into the database and ensure strict sanitisation of IPC extension payloads (detailed in Section 9.2), the agent must explicitly mandate and utilize **Zod** for all runtime schema validations.  
* **Form State:** To manage complex, nested item creation states without causing expensive React re-renders on every keystroke, the agent must implement **React Hook Form**. The agent must pair this with the @hookform/resolvers/zod package to bind the Zod validation schemas directly to the form lifecycle. Hand-rolling uncontrolled inputs or importing heavy enterprise form libraries (e.g., Formik) is strictly forbidden.

#### **2.4.5 PWA & Build Tooling**

* **Service Worker Generation:** To prevent hallucination of complex, outdated caching strategies, the agent must exclusively use **vite-plugin-pwa** for generating the Service Worker and Web App Manifest. Hand-rolling sw.js or manual workbox configuration is strictly forbidden. This ensures highly reliable offline-fallback routing and seamless asset caching.

## **3\. UI/UX Principles**

* **Global Error Boundary & "Unbricking":** The application must implement a top-level React ErrorBoundary (e.g., using react-error-boundary). If local OPFS data or React state becomes hopelessly corrupted (resulting in a crash), the fallback UI must present a "Safe Mode". This screen must expose emergency "Export Data (JSON)", **"Download Raw .sqlite Binary"**, and "Hard Reset & Purge Local Data" buttons to ensure the user is never permanently locked out of a white-screen loop. **Even if the web app crashes, a developer or power user can open the raw binary in an external desktop tool (like DB Browser for SQLite) to rescue their data.**  
* **Customisable Dashboard:** The landing page features a customisable widget board. Users can pin specific visualisations, "Low Stock Alerts", "Soon to Expire" trackers, "Overdue Items", Project statuses, or quick-links.  
* **Adaptive Density:** A global toggle allowing the user to switch between a "Data-Heavy" view (dense, tabular layouts) and a "Visual-Heavy" view (large, striking image cards, ample whitespace, and bold typography).  
* **Micro-interactions & Delight:** Every user action (scanning, moving items, completing a project, toggling views) should be met with satisfying, high-quality visual feedback. The interface must incorporate smooth expand/collapse animations, colour pulsing on success states, and tactile hover effects. The application must feel alive and responsive.  
* **Performance & Virtualisation:** The UI must implement pagination and virtualised lists (e.g., via @tanstack/react-virtual) across all item and location views, capable of rendering 100,000+ distinct records smoothly while maintaining complex CSS rendering.  
* **Kiosk & Tablet Ergonomics:** If deployed on hardwired tablet displays or dashboard nodes, standard browser behaviours degrade the experience. The UI must implement strict CSS containment (touch-action: pan-y; user-select: none;) on dashboard views to prevent accidental pinch-to-zoom or text highlighting. Additionally, it must support the native **Screen Wake Lock API** to prevent dashboards from sleeping during active monitoring. **Crucially, the agent must implement strict feature-detection guards** (e.g., if ('wakeLock' in navigator)) before requesting the lock, gracefully degrading if unsupported (such as on iOS/Safari) to prevent unhandled promise rejections crashing the application.  
* **Advanced Search & Filtering:**  
  * The primary search interface will use a **"Visual Builder"** (a purely graphical, highly polished UI providing animated dropdowns and pill-shaped tags for categories, relational operators, capabilities, etc.).  
  * *Roadmap Task:* A hybrid text-based syntax (e.g., cap:voltage\>3.3) should be planned for future power-user expansion but not implemented in the initial phases.  
* **Base Currency:** Financial tracking relies on a single, user-configurable base currency (e.g., GBP, USD, EUR).  
* **Export Wizard:** Exporting views, backups, or BOMs must utilise a **Granular Export Wizard**. Crucially, this wizard must remember the user's last-used settings to make repetitive exports frictionless. *Full database backups must strictly use the Agnostic JSON format defined in Section 2, **or the Vault/Markdown format defined in Section 4.5**.*

## **4\. Core Data Concepts**

* **Items/Parts:** The physical entities being tracked.  
  * *Variant/SKU Relationships:* Implement a Parent/Child (or Meta-Item/Variant) relationship. A parent item (e.g., "Resistor, 0805") holds shared metadata (datasheets, category), while child variants hold specific parameters (e.g., "10kΩ", "1kΩ") and their distinct quantity/location data to prevent massive data duplication.  
  * *Perishables & Batch Tracking:* Items must support optional expiry\_date, batch\_number, and lot\_number fields to track chronological degradation (e.g., solder paste, SLA resins).  
* **Item Lifecycle (Deletions & Condition):**  
  * *Soft Deletion:* Marked as Decommissioned/Broken/Consumed, preserving activity history but hidden from active inventory.  
  * *Hard Deletion:* Permanently purged from the database.  
  * *Condition Tracking:* A Condition enum (e.g., Mint, Good, Needs Repair, Out for Calibration) to provide more granularity than a simple binary active/deleted state.  
* **Composite Items & Assemblies:** When parts are assembled into a Project, the user can choose the final state:  
  1. *Container:* The project becomes a Location/Container holding the individual parts.  
  2. *Singular Object:* The project merges into a single physical inventory Item.  
  3. *Permanent Consumption:* The individual parts are marked as permanently consumed (soft-deleted) and removed from active tracking.  
* **Tracking Levels:**  
  * *Bulk:* High quantity count (e.g., screws).  
  * *Serialised:* Quantity forced to 1\. Adding multiple automatically clones/serialises them into distinct records.  
  * *Consumable Gauge Primitive:* A core tracking primitive for items that degrade continuously rather than discretely (e.g., filament spools, liquids, resin), allowing low-stock alerts based on percentage or remaining weight rather than integer counts.  
* **Activity Log:** A **Persistent Action History** attached to items, retaining an immutable ledger of movements and quantity changes for long-term auditing.  
* **Projects & BOMs (Bill of Materials):**  
  * Items can be "Tentatively Reserved" or "Actually Reserved".  
  * *The Liminal Space of Procurement ("In Transit"):* When a BOM is marked as "Ordered", the items must manifest in an Expected/In Transit status or a dedicated, system-locked "In Transit" location, distinguishing between missing parts and parts arriving soon.  
  * *BOM Costing:* Users can toggle between **Current Replacement Value** (default) and **Point-in-Time Snapshot** (historical cost) when calculating total project cost.  
  * *BOM Ingress:* Users have the choice of **Manual Entry** OR a **Standard CSV/KiCad Import** tool that attempts to auto-match parts based on Manufacturer Part Number (MPN) or Aliases.  
* **Locations & Containers:** Infinite self-referential nesting.  
  * If a location is deleted, orphaned items must default to an **"Unassigned"** location (treated just like any other standard location in the database). **Crucially, this "Unassigned" location is a system-locked entity and must be strictly immune to modification, soft-deletion, or hard-deletion to prevent catastrophic foreign-key sync failures.**  
  * **Categories & Schema Evolution:** Items belong to Categories defining custom fields.  
  * *Lenient Defaulting:* If a schema is updated (e.g., a new required field is added), existing database items are automatically given a null/default value silently to prevent massive user-interruption prompts.  
* **Attachments & Datasheets:** The user can configure the system to use either **Option A: External URLs Only** or **Option B: Hybrid Pointers** (using the File System Access API to link to local PDFs on desktop).  
  * **Strict Sync Isolation (Option B):** To absolutely protect the cloud storage quota, local file blobs referenced via Option B are **strictly excluded** from cloud synchronisation. The sync engine will only synchronise the literal file path pointer (e.g., C:DatasheetsNE555.pdf).  
  * **Graceful Degradation:** If the database is synchronised to a secondary device (e.g., a mobile phone) where that local path is invalid, the UI must gracefully degrade to display an "Unlinked Local File" placeholder, prompting the user to either supply a new local path for that device or an external URL. It must never attempt to upload or download the heavy file blob.  
* **External Scraping Integrity:**  
  * Uses **Universal Alias Mapping** to connect supplier part numbers to local item IDs.  
  * Notifications for scraped updates are user-configurable (Default: Passive Toast Notification).  
  * **CRITICAL:** Scraping must NEVER overwrite or remove a user-created field unless the user explicitly opts into that specific overwrite action.  
* **Borrowing & Checking Out:**  
  * Utilises a **Dedicated "Contacts" Dictionary** to track who has what.  
  * *Ergonomics:* Adding a new contact must be extremely low-friction (e.g., typing a new name in the checkout box auto-creates the contact without forcing the user to navigate to a separate setup screen).  
  * *Due Dates:* A check-out action must support an optional due\_date to facilitate tracking and dashboard alerts for overdue items.  
* **Mobile Scanner Ergonomics:** The scanner UI must be user-configurable between a **Discrete/Modal Scan** (scan one, view profile) and a **Continuous "Checkout" Mode** (keep camera open, scan multiple items to a working queue toast overlay).

### **4.1 The Consumable Gauge Primitive: Schema & Lifecycle**

The standard quantity integer field is insufficient for continuously degrading materials (e.g., 3D printing filament, resins, liquids). The AI agent must implement a dedicated "Consumable Gauge Primitive" to handle these items, keeping mathematical calculations isolated from the generic item logic.

#### **4.1.1 Database Schema Representation**

The SQLite items table (or a dedicated item\_consumables extension table) must include the following strictly typed fields to handle physical tracking, alongside a flexible metadata layer for operational parameters:

* tracking\_mode: Enum/String (e.g., 'DISCRETE', 'SERIALISED', 'CONSUMABLE\_GAUGE').  
* unit\_of\_measure: String (e.g., 'g', 'kg', 'ml', 'm'). Required if mode is CONSUMABLE\_GAUGE.  
* gross\_capacity: Float. The total amount of usable material when brand new (e.g., 1000.0 for a 1kg spool).  
* tare\_weight: Float. The weight/volume of the empty container/spool (e.g., 250.0 for the plastic spool). Default 0 if not applicable.  
* current\_net\_value: Float. The actual usable material remaining.  
* operational\_metadata: JSON Blob. A strictly parsed, schema-less JSON object allowing the user to store arbitrary operational parameters intrinsic to the physical item's utility. This ensures the system can track the nuances of *any* material without forcing rigid schema migrations (e.g., {"bed\_temp\_celsius": 60, "extrusion\_multiplier": 0.98, "drying\_time\_hrs": 4, "viscosity\_cps": 250}). *(Note: For chronological degradation like resin shelf-life, the root item expiry\_date should be utilised).*

*Calculated State (Handled by the Repository Layer, NOT stored in DB):*

* percentage\_remaining: (current\_net\_value / gross\_capacity) \* 100  
* current\_gross\_weight: current\_net\_value \+ tare\_weight

#### **4.1.2 UI Lifecycle & Update Modes**

When a user updates a Consumable Gauge, the UI must intelligently offer two distinct interaction modes to accommodate different real-world workflows:

1. **Relative Update (The "Consumption" Mode):**  
   * **Use Case:** The user knows exactly how much they just used (e.g., a 3D slicer reports exactly 45g of filament used).  
   * **UI Input:** User inputs \-45g.  
   * **System Action:** System subtracts 45g from current\_net\_value.  
2. **Absolute Update (The "Weigh-In" Mode):**  
   * **Use Case:** The user does not know how much they used, but they can place the item on a scale right now.  
   * **UI Input:** User inputs the *total gross weight on the scale* (e.g., 650g).  
   * **System Action:** System subtracts the tare\_weight (e.g., 250g) from the inputted gross weight, and sets the current\_net\_value to the result (400g). **Crucially, to ensure Conflict-free Replicated Data Type (CRDT) integrity, the React layer must mathematically convert this absolute weigh-in into a relative delta (calculating the difference locally) BEFORE writing to the database, ensuring only the relative delta change is stored in the Activity Log for the sync engine.**

#### **4.1.3 Visualisation & Alerts**

* **The Gauge UI:** In the "Visual-Heavy" view, these items must display a visually striking circular gauge or a fluid linear progress bar.  
* **Dynamic Colours:** The gauge must automatically transition colours based on percentage\_remaining (e.g., Vibrant Green \> 50%, Amber \< 50%, Crimson Red \< 15%), paired with smooth animations as the values shift.  
* **Action History Ledger:** Every update to a gauge must write a transaction to the Activity Log. For instance, if a user does a "Weigh-In", the log must record: *"Calibrated gross weight to 650g (Calculated usage: \-45g)"*.

### **4.2 Image Storage & Performance Strictures (Phase 3 Deep Dive)**

If left unconstrained, AI agents default to encoding images as Base64 strings and storing them directly within the primary items table. When scaling to 10,000+ items, this inflates the primary table size massively, resulting in fatal memory spikes when querying lists and crippling the Web Worker RPC bridge. The agent must strictly adhere to the following architecture for image storage.

#### **4.2.1 The Anti-Base64 Directive**

* **Forbidden Format:** The agent must *never* store images as Base64 strings in the database.  
* **Strict Separation:** The primary items table must contain strictly lightweight data (text, integers, booleans, and floats). Image metadata must be stored in a completely separate, dedicated table (e.g., item\_images) pointing to external or file-system-based assets.

#### **4.2.2 The item\_images Schema (OPFS Approach)**

The dedicated image table must strictly limit the data piped across the Web Worker RPC bridge. The schema must enforce:

* id: UUIDv4.  
* item\_id: Foreign key linking to the primary item.  
* thumbnail\_blob: A BLOB column containing a heavily compressed, tiny version of the image (e.g., maximum 150x150 pixels) suitable for rapid list-view rendering.  
* full\_res\_opfs\_path: A String column containing the relative OPFS file path to the high-resolution image (e.g., '/opfs/images/item\_xyz.webp').

#### **4.2.3 Mandatory Client-Side Processing & OPFS Storage**

The React layer must never pass raw, multi-megabyte smartphone camera photos directly to the database worker.

* **Compression Pipeline:** Before passing an image to the Repository layer, the React frontend must draw the file to a hidden \<canvas\>, downsample it (e.g., maximum dimension of 1080px), and convert it to a highly efficient WebP binary blob (canvas.toBlob(..., 'image/webp', 0.8)).  
* **OPFS Raw File Save:** The agent must bypass SQLite entirely for binary image storage. Instead, the agent should use the native OPFS API to save the compressed WebP image as a raw file in a hidden directory. Only the string path to this file is sent to the database worker.  
* **Thumbnail Generation:** The same pipeline must generate the parallel thumbnail\_blob before submitting the transaction to the worker.

#### **4.2.4 Lazy Loading via the RPC Bridge**

* **List Views:** When ItemRepository.getPaginated() or ItemRepository.search() is called to populate the dashboard or virtualised lists, the SQL query must JOIN the item\_images table but strictly SELECT thumbnail\_blob only.  
* **Detail Views:** The full\_res\_opfs\_path is only queried across the Web Worker RPC bridge when the user explicitly clicks into that specific item's detailed profile page. The UI must then read the file directly from the OPFS hierarchy via the native file system API, completely circumventing SQLite for the heavy lifting.

### **4.3 Tool Maintenance, Calibration, and Condition**

High-value serialised assets (3D printers, CNC routers, multimeters) have complex lifecycles requiring regular maintenance and calibration, shifting their operational status over time.

* **Maintenance Schedule Primitive:** The agent must introduce a primitive for serialised items that hooks into the Activity Log to trigger alerts based on time elapsed or usage metrics (e.g., lubricating rails every 100 hours).  
* **Condition States:** As established in the core concepts, items will utilise a Condition enum to actively reflect their current operational state alongside basic active/decommissioned flags.

### **4.4 Cycle Counting & Formal Reconciliation**

While the "Weigh-In" mode handles single-item updates, standard inventory inevitably drifts out of synchronisation silently (parts are dropped, misplaced, or used without scanning).

* **Cycle Count/Audit Mode:** The agent must implement a specialised workflow where a user is prompted to blind-count a specific location (e.g., "Drawer A2").  
* **Variance Resolution:** The system must highlight variances between the expected database quantity and the physical count, requiring the user to explicitly authorise a "Reconciliation Adjustment" transaction in the Activity Ledger, formalising the audit.

### **4.5 Markdown Vault & Obsidian Integration**

The application must support exporting inventory as a completely decoupled, human-readable Markdown vault (optimised for Obsidian.md).

* **Mechanism:** The agent must utilise a client-side archiving library (e.g., fflate or JSZip) to generate a .zip file containing the folder hierarchy.  
* **Asset Mapping:** Full-resolution images and thumbnails must be extracted from the OPFS, placed in an /assets subdirectory within the zip, and dynamically linked in the Markdown files using standard wiki-link syntax (\!\[\[image\_name.webp\]\]).  
* **Data Structure:** Every item becomes a .md file. Relational data (Quantity, Condition, MPN, Category, Location) must be formatted as strictly typed YAML Frontmatter at the top of the file, enabling external querying via tools like Obsidian Dataview. The item's description, active project reservations, and a formatted markdown table of its Activity Ledger must populate the markdown body.  
* **Granularity:** The Export Wizard UI must allow exporting a single item (exports \[Item Name\].md and its images), an entire Project/BOM Scope (exports a folder containing the Project's master .md file alongside sub-folders of associated components), or a full database Vault Scope (structured by physical Location folders, e.g., Workshop/Cabinet A/Resistor 10k.md).

## **5\. Implementation Phases**

*Each phase acts as a strict boundary. In accordance with **Protocol Gamma**, the agent is authorised to execute the entirety of a phase autonomously, only halting for human intervention if it encounters a designated threshold. It must completely satisfy the deliverables of a given phase before transitioning to the next.*

### **Phase 1: Project Scaffolding, PWA & WASM SQL (FTS5)**

* **Objective:** Initialise the repository, configure PWA manifests, service workers, and the WASM SQL database compiled with FTS5.  
* **Deliverables:** Basic project structure, offline-capable PWA, local DB connection, explicit storage persistence requests, hard-stop storage safeguards, and mobile storage eviction warnings.

### **Phase 2: Core Domain Models (Items, Quantity, Locations & Logging)**

* **Objective:** Implement CRUD operations, nested locations, the "Unassigned" default location, Continuous Consumable Gauges, and the Persistent Action History.  
* **Deliverables:** DB schema, UI for creating/moving items, Data-Heavy vs Visual-Heavy toggle (with engaging visual feedback), and virtualised lists leveraging strict RPC pagination.

### **Phase 3: Category Schemas, Pointers & Dual-Tracking Levels**

* **Objective:** Implement Categories, dynamic custom fields (with lenient defaulting), unstructured tags, image compression, and Datasheet Pointers vs URLs.  
* **Deliverables:** Category UI, logic to auto-clone serialised items, freeform tagging UI, and datasheet linking configuration.

### **Phase 4: Projects, Reservations, Procurement & BOM Imports**

* **Objective:** Build the workflow tools for using the inventory.  
* **Deliverables:** UI to create Projects, manual/CSV BOM imports, Current vs Snapshot costing toggle, "Permanent Consumption" assembly logic, and automated Shopping List views.

### **Phase 5: Capabilities, FTS5 & Advanced Visual Search**

* **Objective:** Implement the Weighted Capabilities tagging system and the dual search engines.  
* **Deliverables:** Visual Builder UI for complex graphical queries, SQLite FTS5 implementation for rapid text matching.

### **Phase 6: QR Code, Configurable Mobile Scanner & Contacts**

* **Objective:** Implement tracking codes, scanner UI, the checkout lifecycle, and the Export Wizard.  
* **Deliverables:** Printable QR generation, configurable camera scanner (Discrete vs Continuous modes), low-friction Contacts dictionary for borrowing, and the memory-retaining Export Wizard.

### **Phase 7: Cloud Sync & File System Access**

* **Objective:** Implement automated data safeguarding.  
* **Deliverables:** Integration with the File System Access API and an Explicit Handshake cloud provider wrapper (implementing Last Write Wins, clock drift protection, and payload sanitisation).

### **Phase 8: External Data Scraping via Extension**

* **Objective:** Build the web scraping infrastructure bypassing CORS.  
* **Deliverables:** A companion browser extension featuring Universal Alias Mapping, configurable passive toasts, and strict protections against overwriting custom user fields.

### **Phase 9: Procurement & Lifecycle Logistics**

* **Objective:** Implement time-based item degradation, variant relationships, and advanced auditing workflows.  
* **Deliverables:** Expiry Dates and Batch tracking, Parent/Child item variants, "In Transit" procurement logic, Tool Maintenance Schedules, Borrowing Due Dates, and the Cycle Counting/Reconciliation mode.

### **5.1 The Visual Search AST Schema (Phase 5 Deep Dive)**

To prevent the agent from inventing a non-performant, convoluted parser for the Visual Builder, the ephemeral Abstract Syntax Tree (AST) must strictly adhere to the following JSON schema. The Repository layer will traverse this schema to generate the final SQLite FTS5 / WHERE clauses.

* **The AST TypeScript Interface:**  
  type LogicalOperator \\= 'AND' | 'OR';    
  type FilterOperator \\= 'EQUALS' | 'CONTAINS' | 'GREATER\\\_THAN' | 'LESS\\\_THAN' | 'HAS\\\_CAPABILITY';    
  interface FilterCondition {    
  field: string; // e.g., 'category', 'mpn', 'quantity', 'capability:voltage'    
  operator: FilterOperator;    
  value: string | number | boolean;    
  }    
  interface ASTGroupNode {    
  type: 'GROUP';    
  logicalOperator: LogicalOperator;    
  conditions: Array\\\<ASTGroupNode | FilterCondition\\\>;    
  }    
  // The root state of the Visual Builder is always an ASTGroupNode    
  type SearchAST \\= ASTGroupNode;  

* **Translation Directive (Parameterised Tuple Enforcement):** The agent must write a single, predictable utility function (parseASTtoSQL) that recursively maps this exact structure into parameterised SQLite queries. **String concatenation for value insertion is strictly forbidden.** The function must be designed to return a strictly typed tuple:  
  \]. Furthermore, the agent must mandate a hard limit on AST recursion depth (e.g., maximum 4 nested GROUP nodes) to prevent accidental stack overflow vulnerabilities during local execution or catastrophic backtracking.

## **6\. Mobile Scanner State Machine & WebRTC Ergonomics**

*(Deep Dive for Phase 6\)* The mobile scanner module must be highly robust, handling the nuances of mobile browser hardware access. The AI agent must implement a strict state machine to govern the camera lifecycle and provide distinct ergonomics for "Discrete" versus "Continuous" scanning modes.

### **6.1 WebRTC Lifecycle & Battery Management**

The camera stream (via getUserMedia) is resource-intensive. The agent must implement the following safeguards:

* **Visibility API Hooks:** The scanner component must listen to the document.visibilitychange event. If the browser is backgrounded, the camera track must immediately be stopped (track.stop()) to release the hardware and save battery. It should automatically request to re-initialise when the user returns.  
* **Unmount Cleanup:** When the scanner modal is closed, all video streams and animation frames must be definitively terminated.

### **6.2 The Scanner State Machine**

The component must utilise a discrete reducer or state machine (avoiding unstructured boolean flags like isScanning and isLoading co-existing in conflicting states).

* IDLE: Awaiting user interaction to open the scanner.  
* REQUESTING\_PERMISSIONS: Waiting for browser permission to access the camera.  
* STREAM\_ACTIVE: Camera is live and searching for QR/Barcodes.  
* PROCESSING\_QUEUE: Camera paused/dimmed while the user reviews a batch of scanned items.  
* ERROR\_STATE: Handling denied permissions, unsupported hardware, or generic stream failures.

### **6.3 Interaction Modes**

The user can toggle between two distinct scanning modes, which dictate what happens immediately following a successful scan:

1. **Discrete Mode (Single-Action Focus):**  
   * **Behaviour:** Upon detecting a valid code, the camera stream is instantly paused, and the scanner UI collapses with a fluid, satisfying animation.  
   * **Result:** The user is immediately redirected to the scanned item's detailed profile page, or a full-screen modal opens to perform a single action (e.g., "Check Out This Item").  
2. **Continuous Mode (Batch Checkout/Inventory Auditing):**  
   * **Behaviour:** Upon detecting a code, the camera remains active. The UI registers a "hit" but does not interrupt the viewfinder.  
   * **Result:** The scanned item is pushed to a temporary **"Working Queue"** (an ephemeral array in React Context). A highly polished, dismissible toast overlay displays the queue size (e.g., *"3 items scanned. Tap to review."*).  
   * **Finalisation:** The user manually taps the queue overlay to pause the camera and apply a batch action (e.g., moving all 3 items to a new location).

### **6.4 Debouncing & Double-Scan Prevention**

To make Continuous Mode usable, the agent must implement a **Cooldown Map** strategy:

* Maintain an ephemeral map of {  
  : number } (e.g., mapping the scanned UUID to a timestamp).  
* When a code is recognised, check the map. If the same ID was scanned within the last **2000 milliseconds**, ignore the new scan entirely.  
* This prevents a single physical label from registering 15 times whilst the user moves their hand across the frame.

### **6.5 Ergonomic Feedback**

Because the user will not be looking at the screen during Continuous Mode, the system must provide engaging, non-visual confirmation:

* **Haptic:** Trigger navigator.vibrate(200) for a short, crisp physical bump on a successful scan.  
* **Audio:** Trigger a short, premium-sounding synthesised 'beep' via the Web Audio API (ensuring it is initialised on first user interaction to bypass browser autoplay policies).

### **6.6 Barcode Parsing Library Definition**

To prevent the AI from pulling in massive, outdated scanning libraries (like Java-ported ZXing) which unnecessarily bloat the application bundle, the agent must adhere to a strict tiered approach for barcode decoding:

* **Primary Engine:** The scanner must attempt to use the modern, native **Barcode Detection API** first, allowing the browser to offload processing to the device's native hardware, saving battery and maximizing framerates.  
* **WASM Fallback:** Only if the native API is unsupported on the target device, the agent must implement a lightweight WebAssembly (WASM) fallback library (e.g., html5-qrcode or @zxing/browser) to guarantee cross-compatibility across all browsers without crippling performance.

## **7\. Sync Orchestration & "Last Write Wins" Resolution**

*(Deep Dive for Phase 7\)* The application must operate strictly as a Local-First architecture. The local SQLite WASM database is the Single Source of Truth (SSOT) during active use. Cloud synchronisation is treated as an asynchronous background reconciliation process, strictly utilising a "Last Write Wins" (LWW) strategy based on row-level timestamps.

### **7.1 Schema Requirements for LWW**

To support LWW, the agent must implement specific schema augmentations across **all** user-modifiable tables (e.g., items, locations, categories):

* **id (UUIDv4):** All primary keys must be cryptographically random UUIDs, not auto-incrementing integers, to prevent collision during offline creation across multiple devices.  
* **updated\_at (INTEGER):** A strict UNIX epoch timestamp (milliseconds). The database must use SQLite AFTER UPDATE triggers to automatically set this field to the current UTC time whenever a row is modified, ensuring the React layer cannot accidentally bypass timestamping.

### **7.2 The Tombstone Pattern (Handling Deletions)**

A standard DELETE statement destroys the record. If a device syncs after a local hard delete, the cloud might interpret the missing row as "needs to be downloaded" rather than "needs to be deleted globally".  
To resolve this, the agent must implement a **Tombstone Pattern**:

* **Soft Deletions:** Used for the standard item lifecycle (e.g., "Consumed"). Updates an is\_active boolean to false and updates updated\_at.  
* **Hard Deletions (Tombstones):** When a user explicitly purges an item, the row is removed from the items table, but a record is immediately inserted into a dedicated tombstones table containing id, table\_name, and deleted\_at.  
* During synchronisation, the sync engine checks the tombstones table to propagate hard deletes to the remote state.  
* **Epoch-Based Pruning (TTL):** To prevent storage bloat, the agent must implement a strict "Tombstone TTL" (Time-To-Live). A background utility within the Web Worker must purge tombstone records older than 180 days. To mitigate the risk of an offline peer coming online after 180 days and missing the deletion, any device attempting to sync with a last\_sync\_timestamp older than the TTL must undergo a full database state wipe and remote clone rather than a delta reconciliation.  
* **Pre-Wipe Salvage Protocol (TTL Guard):** If a device reconnects after the Tombstone TTL has expired, it must **not** blindly wipe the database. The sync engine must first perform a "Pre-Wipe Salvage" by querying the local item\_history for any local mutations or creations that occurred *after* the last\_sync\_timestamp. These orphaned transactions must be temporarily exported to an ephemeral memory store, the database wiped and cloned from the remote, and then the salvaged transactions mathematically re-applied on top as new local-wins to prevent the destruction of offline work.

### **7.3 The Synchronisation Lifecycle**

The sync process must be atomic and non-blocking to the main UI thread. It follows a strict reconciliation loop, employing standard Last Write Wins (LWW) for discrete fields and a Delta-CRDT (Conflict-free Replicated Data Type) approach for continuous values:

1. **Fetch Remote State (NTP Offset Guard):** Download the remote payload. To protect against client-side clock drift, the system must ping a lightweight, reliable time server (or the cloud provider's API header) to calculate a local\_clock\_offset. The agent must mathematically apply this offset to all local updated\_at timestamps before diffing, ensuring chronologically accurate LWW resolution.  
2. **Diffing Engine (LWW & Delta Reconciliation):**  
   * Compare remote rows against local rows by id.  
   * **Strict Payload Sanitisation:** To prevent Version Mismatch crashes (where a peer running an older schema attempts to insert data from a newer peer), the engine must implement a Schema Dictionary. Before preparing UPSERT commands, the engine must strip any keys from the incoming remote JSON payload that do not exist in the local database's current schema.  
   * **Standard LWW Resolution:** For discrete fields (e.g., names, descriptions, categories), if remote.updated\_at \> local.updated\_at, prepare an UPSERT (remote wins). If local.updated\_at \> remote.updated\_at, prepare an UPSERT payload for the cloud (local wins).  
   * **Delta Resolution (Consumable Gauges):** For continuous value fields (specifically current\_net\_value on CONSUMABLE\_GAUGE items), LWW is strictly forbidden, as it would silently overwrite concurrent offline usage. Instead, the engine must parse the item\_history (Activity Ledger) to extract the operational deltas (e.g., \-45g from Device A and \-10g from Device B). It must replay these deltas chronologically to calculate the true synchronised current\_net\_value before preparing the UPSERT.  
   * **Tombstone Resolution:** If id exists in remote tombstones with a newer timestamp, prepare a DELETE for the local row.  
3. **Atomic Transaction:** Execute all winning remote UPSERT and DELETE commands locally within a single SQLite BEGIN TRANSACTION; ... COMMIT;.  
4. **Push Local State:** Upload the winning local diffs (including the newly calculated delta reconciliations) back to the cloud provider.

### **7.4 Storage Safeguards & The "Hard Stop"**

Browsers will aggressively evict local storage (Origin Private File System / IndexedDB) if limits are breached.

* **Explicit Persistence Verification:** As outlined in Section 2, the application must already have established navigator.storage.persist(). If this protection is missing, the user remains highly vulnerable.  
* **Pre-Flight Quota Check:** Before initiating the "Fetch Remote State" phase, the agent must query navigator.storage.estimate().  
* **Graceful Rollback:** If the estimated remote diff exceeds 90% of the available quota, the synchronisation must abort entirely, issuing a "Hard Stop" error to the user rather than risking partial transaction corruption or browser eviction.

### **7.5 Relational Integrity & Orphan Resolution**

In a distributed, offline-first environment, standard "Last Write Wins" (LWW) resolution is insufficient for handling relational data. The agent must anticipate and gracefully handle foreign key conflicts that arise during synchronisation.

#### **7.5.1 The Orphaned Item Conflict**

* **The Scenario:** Device A soft-deletes or hard-deletes a Location. While offline, Device B moves several Items into that specific Location. Both devices then synchronise with the remote state.  
* **The Threat:** If the database worker blindly applies the incoming LWW payload from Device B, it will attempt to insert Items with a location\_id that no longer exists in the local database (or exists purely as a tombstone), triggering a SQLITE\_CONSTRAINT\_FOREIGNKEY violation and crashing the entire atomic sync transaction.

#### **7.5.2 The Intercept and Re-Parent Strategy**

To prevent this, the sync engine's Diffing Engine (Section 7.3) must implement a topological validation step before executing the final BEGIN TRANSACTION:

* **Location Verification:** For every incoming Item UPSERT, the engine must verify if the target location\_id exists and is active (not tombstoned).  
* **Automatic Re-Parenting:** If the target location is missing or tombstoned, the engine must intercept the UPSERT payload and mutate the location\_id to the system's default **"Unassigned"** location ID (defined in Section 4).  
* **Conflict Logging:** The engine must append an entry to the Item's Activity Log stating: *"Location sync conflict: Re-parented to Unassigned as target location was removed."* This ensures the user is aware of the automated resolution without being interrupted by a fatal error prompt.

#### **7.5.3 Cyclical Nesting Prevention**

Because Locations can be infinitely nested (Section 4), distributed writes risk creating infinite architectural loops (e.g., Device A moves Location X into Location Y; Device B moves Location Y into Location X).

* **Cycle Detection:** Prior to committing any Location UPSERT payload that modifies a parent\_id, the Repository layer must execute a recursive Common Table Expression (CTE) query to traverse the incoming hierarchical tree.  
* **Graceful Rejection:** If a cycle is detected, the incoming LWW update for that specific Location movement is discarded, maintaining the local hierarchical state, and a warning is logged to the system console.

### **7.6 OPFS Quota Recovery & Archiving Workflows**

While Section 7.4 establishes a "Hard Stop" to prevent database corruption during synchronisation, the system must also provide a resilient recovery pathway when the Origin Private File System (OPFS) approaches its maximum browser-allocated quota. The AI agent must implement a structured archiving workflow to prevent permanent user lock-out.

#### **7.6.1 Continuous Storage Telemetry**

Relying solely on a pre-flight check during synchronisation is insufficient. The React frontend must proactively monitor the storage state.

* **Background Polling:** The system must utilise a web worker or a low-priority interval to poll navigator.storage.estimate() every 5 minutes during an active session.  
* **Tiered Degradation Warnings:**  
  * **Warning State (80% Quota):** Display a dismissible yellow banner.  
  * **Critical State (90% Quota):** Display a persistent red banner and disable all non-essential UI features (e.g., uploading new high-resolution images).  
  * **Locked State (95% Quota):** Trigger the "Hard Stop". All database INSERT and UPDATE operations are suspended except for DELETE operations required to free space.

#### **7.6.2 The Storage Triage Dashboard**

When a user enters the Critical or Locked state, they must be directed to a dedicated **Storage Triage Dashboard**. The agent must build a UI that visually breaks down OPFS consumption by table.  
Because SQLite WASM cannot natively query table sizes without significant performance overhead, the agent must estimate consumption by querying row counts and multiplying by average byte-sizes, specifically separating:

1. **The Image Table (item\_images)**  
2. **The Activity Log (item\_history)**  
3. **Core Item Data (items)**

#### **7.6.3 Graceful Pruning & "Cold Storage" Export**

The agent must implement specific, guided workflows for users to reclaim space without blindly deleting their active inventory.

* **Workflow A: Action History Pruning**  
  * **Target:** The item\_history table (which tracks every minute quantity change) will inflate rapidly.  
  * **Mechanism:** The UI must offer a "Purge History Older Than X Months" action.  
  * **Safeguard:** Before executing the DELETE command, the system must automatically generate a JSON array of the targeted rows and trigger a standard browser download (inventory\_history\_archive.json). This ensures the audit trail is preserved in "Cold Storage" before being purged from the local OPFS database.  
* **Workflow B: Image Downgrading**  
  * **Target:** The full\_res\_blob column within the item\_images table.  
  * **Mechanism:** If the user primarily uses the application on mobile, they may not need full-resolution images stored locally.  
  * **Safeguard:** The agent must implement a background migration script that drops the full\_res\_blob data for older items, retaining only the lightweight thumbnail\_blob. Crucially, this must *not* propagate as a deletion to the Cloud Sync provider; it simply frees local OPFS space while leaving the remote cloud payload intact.

## **8\. Agent Execution Protocols**

To ensure architectural integrity across multiple LLM chat sessions, the AI agent must strictly adhere to the following operational protocols.

### **8.1 Protocol Alpha: Inter-Session State Checkpointing (The Handover)**

**Context:** To prevent context-window degradation, the human developer will initiate a completely new chat session for each Phase defined in Section 5\. The agent must never assume it will retain memory of previous conversations.  
**The Mandate:** At the successful conclusion of every phase, before the session is terminated, the agent **MUST** generate a comprehensive PHASE\_HANDOVER.md file. This document acts as the absolute source of truth for the incoming agent in the next session.

#### **8.1.1 The Handover Generation (End of Session)**

When the human user states: "Phase X is approved. Generate the Handover Document," the agent must produce a markdown file containing strictly the following:

1. **Current Database Schema Snapshot:** The exact SQL CREATE TABLE and CREATE TRIGGER statements currently active in the SQLite WASM database. This prevents the incoming agent from hallucinating column names or bypassing the UUID/timestamp requirements.  
2. **Active Repository Interfaces:** A list of all established methods within the Repository layer (e.g., ItemRepository.ts). The agent must list the function signatures (inputs/outputs) so the next agent knows how to interact with the database without writing raw SQL.  
3. **State Management Roster:**  
   * *TanStack Query:* A list of all active query keys (e.g.,  
     ) and custom hook names (e.g., useInventoryItems).  
   * *Zustand:* The exact interface/type definitions of any global stores created (e.g., useLayoutStore).  
4. **Component Tree Topography:** A brief hierarchical map of the major React components established in the current phase, defining their specific domain responsibilities.  
5. **Technical Debt & Stubs:** A clear declaration of any logic that was intentionally stubbed out or delayed to adhere to the YAGNI principle.

#### **8.1.2 The Handover Ingestion (Start of New Session)**

When starting a new phase, the human developer will provide the master specification alongside the PHASE\_HANDOVER.md from the previous phase.

* **Strict Initialisation Rule:** The new agent **MUST NOT** write a single line of code or propose any new architecture until it has explicitly parsed and summarised **both the original Master Specification AND the PHASE\_HANDOVER.md document.**  
* It must acknowledge the established Repository patterns and State models, confirming it will use the existing ItemRepository methods rather than inventing new data-fetching paradigms.

### **8.2 Protocol Beta: Autonomous TDD & Self-Validation**

**Context:** While the agent is empowered with continuous execution (Protocol Gamma), the complexity of local-first SQLite WASM data layers still demands mathematical and structural proof before UI generation. However, this validation must now be autonomous rather than human-gated.  
**The Mandate:** The agent must enforce a Test-Driven Development (TDD) loop internally. It must define the test contract, write the implementation, and self-validate the logic before autonomously proceeding to the UI layer.

#### **8.2.1 Step 1: Autonomous Test Definition**

Before writing implementation code for a new domain feature (e.g., Consumable Gauge Primitive), the agent must first scaffold the unit tests (e.g., using Vitest or Jest syntax).

* These tests must assert database schemas, expected mathematical outcomes, and boundary error handling.

#### **8.2.2 Step 2: Implementation & Self-Execution**

The agent will generate the corresponding TypeScript Repository class or SQLite transaction block to satisfy the tests.

* The agent must then autonomously execute the test suite (if the local execution environment permits) or perform a rigorous simulated trace of the logic against the test assertions.  
* **Fluid Progression:** If the logic passes self-validation, the agent is authorised to immediately proceed to writing the TanStack Query hooks, Zustand slices, and React components without human intervention.

#### **8.2.3 Step 3: The TDD Halt Condition**

The agent must only stop and request human assistance during the TDD phase if:

* The tests consistently fail after the two permitted correction attempts (see Protocol Delta).  
* Resolving the test failure requires a fundamental change to the database schema that contradicts the previously approved PHASE\_HANDOVER.md.

### **8.3 Protocol Gamma: Autonomous Execution & Direct Codebase Modification**

**Context:** The agent operates within an environment granting direct read/write access to the project file system. Previous constraints requiring manual human copy-pasting or micro-authorisation at every development step (such as the TDD validation gates in early specifications) are hereby superseded. The primary objective is momentum and fluid development within the strict bounds of a single phase.  
**The Mandate:** The agent is empowered to implement the active phase autonomously from start to finish. It must self-validate its logic and only interrupt the human developer when encountering severe architectural ambiguity, high-risk data modifications, or the completion of the phase.

#### **8.3.1 The Continuous Implementation Loop**

Within the scope of the currently active phase, the agent is authorised to proceed continuously without waiting for human permission between tasks.

* **Fluid Progression:** The agent may write the repository logic, generate the TanStack Query hooks, configure the Zustand stores, and build the React UI in a single, uninterrupted workflow.  
* **Self-Correction:** If the agent encounters a TypeScript error, linting failure, or missing dependency during its generation loop, it must attempt to autonomously resolve the issue (up to the two-strike limit defined in Protocol Delta) before halting to ask for human intervention.

#### **8.3.2 The "Halt & Query" Thresholds**

The agent must suspend autonomous execution and explicitly request human input *only* when one of the following thresholds is met:

1. **Architectural Ambiguity:** The specification lacks clarity regarding a critical dependency, state flow, or UI layout, and guessing would risk structural debt.  
2. **Scope Creep / YAGNI Risk:** A requested feature or necessary refactor appears to bleed into the requirements of a *future* phase or violates the "You Aren't Gonna Need It" principle.  
3. **Destructive Schema Changes:** A modification requires dropping database columns, altering primary keys, or performing migrations that could result in irreversible data loss for existing local records.  
4. **Phase Completion:** All objectives for the current phase have been met, and the agent is ready to generate the PHASE\_HANDOVER.md document.

#### **8.3.3 Safe Direct Patching Hygiene**

Because the agent has direct file-system access, it must exercise extreme discipline when modifying existing files to prevent accidental code deletion.

* **Surgical Edits:** When modifying an existing file, the agent must parse and replace only the necessary logic block, leaving surrounding functions, import statements, and context entirely intact.  
* **No Truncation:** The agent must never write placeholder comments (e.g., // ... rest of the file remains unchanged) directly to the disk. All file writes must be structurally complete and syntactically valid.  
* **Dependency Resolution:** If a newly written component requires a new package (e.g., lucide-react), the agent must either autonomously execute the package manager installation command (if permitted by the environment) or clearly list the required npm install commands at the end of its output before proceeding.

### **8.4 Protocol Delta: Blast Radius & Autonomous Rollback Procedures**

**Context:** When debugging errors, autonomous agents frequently exhibit "panic behaviour"—applying rapid, compounded fixes to multiple files without understanding the root cause, thus expanding the "blast radius" and corrupting previously stable code.  
**The Mandate:** The agent is strictly forbidden from applying cascading "band-aid" fixes. All debugging must follow a disciplined, isolated approach with mandatory rollback triggers.

#### **8.4.1 Step 1: Blast Radius Declaration**

Before attempting to fix a complex bug or implement a refactor, the agent must briefly log (in its internal reasoning or output trace) the target "Blast Radius"—exactly which files and database tables will be modified.

* If a fix for a UI component requires modifying the foundational Repository layer or altering SQLite schemas, the agent must treat this as a **Destructive Schema Change** and halt to query the Senior Architect (per Protocol Gamma).

#### **8.4.2 Step 2: The Two-Strike Rollback Rule**

The agent is permitted a maximum of two iterative attempts to fix a specific bug autonomously.

* If the error persists after the second attempt, the agent **MUST STOP** writing code.  
* **Autonomous Version Control:** If the agent's environment supports terminal execution, it must autonomously execute a git stash or git checkout to revert the modified files back to the last known good state. If it cannot execute terminal commands, it must explicitly instruct the human developer to perform the Git rollback.

#### **8.4.3 Step 3: Root Cause Pause**

Following an autonomous or manual rollback, the agent is forbidden from immediately proposing another code change.

* It must output a "Root Cause Analysis" explaining *why* the previous autonomous attempts failed and reassessing its mental model of the system architecture.  
* It must await human authorisation on the newly proposed logic before resuming read/write operations.

### **8.5 Web Worker Mocking & TDD Ergonomics**

*(Deep Dive for Protocol Beta)* Testing Web Workers and the Origin Private File System (OPFS) within standard Node.js test environments (such as Vitest or Jest) frequently results in stalled execution, silent timeouts, or environment crashes. To successfully fulfil the mandate of Protocol Beta (Autonomous TDD & Self-Validation), the AI agent must implement a robust mocking and abstraction strategy.

#### **8.5.1 The Database Driver Abstraction**

The agent must never tightly couple the Repository layer directly to the Web Worker instantiation or the postMessage API.

* **The Interface:** The agent must define a strict IDatabaseDriver interface that governs all interactions with the database (e.g., execute(sql, params), query(sql, params)).  
* **Dependency Injection:** The Repository classes must accept this driver as an injected dependency upon instantiation, allowing the underlying execution environment to be swapped seamlessly between production and testing.

#### **8.5.2 In-Memory Bypassing for SQL Validation**

When writing unit tests to validate complex mathematical operations (such as the Consumable Gauge calculations) or intricate SQL generation (such as the Visual Builder AST traversal), the overhead of the Web Worker is unnecessary.

* **The :memory: Exception:** Strictly and exclusively within the test environment, the agent is authorised to bypass the Web Worker entirely. It must inject a synchronous, memory-only (:memory:) SQLite database driver into the Repository layer.  
* **Behaviour:** This ensures the test suite executes instantaneously and validates the exact SQL syntax against a real SQLite engine without requiring browser storage APIs.

#### **8.5.3 RPC Bridge Mocking for UI Tests**

When testing the React component tree and the Tier 1 state management layer (TanStack Query hooks), the actual SQL execution is irrelevant.

* **The Mocked Bridge:** The agent must aggressively mock the RPC bridge (e.g., mocking the Comlink proxy or the raw worker.postMessage wrapper).  
* **Deterministic Payloads:** These mocks must return deterministic, strongly typed JSON payloads (simulating the ScrapeResultPayload or Item arrays). The agent must use these mocks to explicitly test the UI's handling of asynchronous loading states, pagination boundaries, and simulated SQLITE\_BUSY error states.

#### **8.5.4 Build-Tool Mocking Configuration**

The agent must explicitly configure the build/test tool (e.g., Vitest) to handle the Web Worker imports seamlessly.

* **Mock Injection:** Instead of attempting to execute the worker natively during UI tests, the agent must use vi.mock('./database.worker?worker', () \=\> ...) or the equivalent framework method at the top of the test files to intercept the instantiation and inject the mock bridge defined in Section 8.5.3.

#### **8.5.5 Real-Browser End-to-End Smoke (Phase 2+)**

The `:memory:` driver and mocked RPC bridge (§8.5.2–§8.5.4) validate SQL, maths, and UI states *without* a browser — fast, but by design they never run the genuine OPFS VFS, SharedArrayBuffer coordination, or the Web Worker bridge. To close that gap, the agent must maintain a lightweight **real-browser end-to-end smoke test** alongside the unit suite.

* **Driver:** **Playwright** as a dev-only dependency (per §1.2.1), launching the **system-installed browser** (`chromium.launch({ channel: 'msedge' })`) so no browser binary is downloaded into the repository. Puppeteer and a bundled Chromium download are not to be introduced without cause.
* **Cross-Origin Isolation:** The smoke test runs against a live **dev server** (or `vite preview`), whose COOP/COEP headers (§2.2.6) make the context cross-origin-isolated — so `crossOriginIsolated`, SharedArrayBuffer, and the OPFS-backed SQLite worker all execute exactly as in production. The test must assert `crossOriginIsolated === true` as a guard.
* **Scope & Hygiene:** It drives the actual user flows of the current phase (e.g. for Phase 2: create items, adjust a Consumable Gauge, toggle layout density, nest locations) and **fails on any console or page error**. It lives at `scripts/browser-smoke.mjs`, is invoked via `npm run test:e2e` (with a dev server running), and any screenshot artefact it emits must be git-ignored. It is a smoke test, not a replacement for the mandatory §8.2 TDD loop.

## **9\. PWA-Extension Communication Protocol**

*(Deep Dive for Phase 8\)* The companion browser extension (used for scraping supplier data bypassing CORS) must communicate with the sandboxed PWA. To ensure robustness and security without over-engineering, the agent must implement a strictly typed **Content Script Bridge** using window.postMessage.

### **9.1 The Secure Bridge Handshake**

The PWA must not accept arbitrary messages from the window object. The agent must implement a strict validation layer:

1. **Origin Verification:** The PWA listener must verify that the event origin matches the expected extension ID or a trusted local context.  
2. **Schema Validation:** Every message must conform to a strict TypeScript union type. If an invalid message is received, it is silently dropped to prevent injection attacks.

### **9.2 The Protocol Schema**

The agent must define a shared ExtensionMessage type interface used by both the PWA and the extension's content script:  
type ExtensionMessageType \\=    
| 'EXTENSION\\\_READY'    
| 'SCRAPE\\\_REQUEST'    
| 'SCRAPE\\\_RESULT'    
| 'SCRAPE\\\_ERROR';    
interface ExtensionMessage\\\<T \\= unknown\\\> {    
source: 'HARDWARE\\\_TRACKER\\\_EXT'; // Mandatory signature    
type: ExtensionMessageType;    
payload: T;    
}    
// Example Payload for SCRAPE\\\_RESULT    
interface ScrapeResultPayload {    
mpn: string;    
manufacturer: string;    
description: string;    
distributor\\\_url: string;    
scraped\\\_pricing: { currency: string, value: number } | null;    
}  

### **9.3 Execution Flow**

1. **Injection & Ready State:** When the user is on the PWA, the extension injects a content script. The script immediately broadcasts an EXTENSION\_READY message.  
2. **UI Unlocking:** The PWA listens for EXTENSION\_READY. Only upon receiving this does the PWA render the "Scrape Supplier" button in the item creation UI.  
3. **The Request Loop:** The PWA sends a SCRAPE\_REQUEST (containing a URL) to the content script. The content script delegates to the extension background worker (to bypass CORS), performs the DOM parsing, and returns the strictly typed SCRAPE\_RESULT payload back to the PWA via postMessage.

### **9.4 Extension Scraping Resilience & DOM Drift Mitigation**

Supplier websites frequently update their DOM structures, which will inevitably break hardcoded scraping selectors (DOM Drift). The agent must implement a resilient architecture to handle these failures gracefully without crashing the extension or silently corrupting PWA data.

#### **9.4.1 The Strategy Pattern for Parsers**

* **Decoupling:** The agent must strictly avoid writing a monolithic, overarching parsing function containing deeply nested if/else statements for different domains. It must implement the Strategy pattern, creating discrete, strongly typed parser classes for each supported supplier (e.g., DigiKeyParser.ts, MouserParser.ts).  
* **Uniform Interface:** All parsers must implement a standard SupplierParser interface that guarantees a predictable return type (matching the ScrapeResultPayload defined in Section 9.2), regardless of the target supplier's internal DOM complexity.

#### **9.4.2 DOM Drift Detection & Strict Validation**

* **No Silent Failures:** If a crucial CSS selector fails to find an element, or if a price string cannot be parsed into a mathematically valid float, the parser must *never* silently guess, return null for the entire payload, or attempt to insert NaN into the database schema.  
* **Explicit Error Marshalling:** The extension must immediately catch the parsing exception and marshal a SCRAPE\_ERROR message back across the Content Script Bridge to the PWA. The payload must explicitly include the targeted domain and the specific failure reason (e.g., error\_type: 'DOM\_DRIFT' | 'NETWORK\_TIMEOUT' | 'RATE\_LIMITED').

#### **9.4.3 PWA Graceful Degradation**

* **User Feedback:** Upon receiving a SCRAPE\_ERROR triggered by DOM drift, the PWA must immediately alert the user via an actionable toast notification (e.g., *"Supplier layout changed. Scraping failed; manual entry required."*).  
* **Fallback UI:** The item creation UI must seamlessly degrade, automatically unlocking the manual entry fields for price, description, and MPN, allowing the user to bypass the broken scraper without interrupting their immediate workflow.