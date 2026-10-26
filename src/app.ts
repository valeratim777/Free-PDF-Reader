import {
  CircleHelp,
  Combine,
  Download,
  Droplet,
  FilePlus,
  FileText,
  FileImage,
  Hash,
  Images,
  Info,
  Languages,
  LayoutGrid,
  Lock,
  Maximize2,
  Moon,
  MonitorDown,
  Printer,
  RotateCw,
  Save,
  Share2,
  SunMoon,
  User,
  Volume2,
  X,
  FolderOpen,
  FileStack,
} from 'lucide';
import { store } from './store';
import { getLang, LANGS, setLang, t } from './i18n';
import { Viewer } from './viewer/viewer';
import { installGestures } from './viewer/gestures';
import { Tools, type Tool } from './annotations/tools';
import { Sidebar } from './ui/sidebar';
import { Search } from './ui/search';
import { MOD, PropsBar, TOOL_INFO, TopBar, ToolBar, logo } from './ui/toolbar';
import { helpDialog } from './features/help';
import { listenForSystemFiles } from './features/native';
import { busy, confirmDialog, dialog, downloadBlob, h, icon, openMenu, pickFiles, promptDialog, toast, type MenuItem } from './ui/dom';
import { openOrganizer } from './ui/organizer';
import { addSource, blankPdfBytes, fileBytes, imagesToPdfBytes, insertBytes, NotPdfError, openBytes, pagesOf, registerAsset } from './features/documents';
import { canShareFiles, download, exportPdf, save, share, suggestedName } from './features/save';
import { exportImagesDialog, exportText, printDocument, readAloud } from './features/output';
import { aboutDialog, authorDialog, numberingDialog, propertiesDialog, protectDialog, watermarkDialog } from './features/docTools';
import { insertImage, signatureFlow, stampFlow } from './features/insert';
import { clearSession, flushSession, loadSession, markRestored, peekSession, scheduleSessionSave, startSession } from './features/session';
import { clearPages } from './pages';
import { clearText } from './text';
import { clearThumbs } from './ui/thumbs';
import type { PageView } from './viewer/pageView';

type InstallPrompt = Event & { prompt(): Promise<void> };

const TOOL_KEYS = new Map<string, Tool>(
  (Object.entries(TOOL_INFO) as [Tool, (typeof TOOL_INFO)[Tool]][]).filter(([, i]) => i.key).map(([tool, i]) => [i.key!, tool]),
);

export class App {
  viewer!: Viewer;
  tools!: Tools;
  sidebar!: Sidebar;
  search!: Search;
  topbar!: TopBar;
  toolbar!: ToolBar;
  props!: PropsBar;
  private welcome!: HTMLElement;
  private badge!: HTMLElement;
  private badgeTimer = 0;
  private dropOverlay!: HTMLElement;
  private installPrompt: InstallPrompt | null = null;

  constructor(private root: HTMLElement) {}

  start(): void {
    this.applyTheme();
    const viewerEl = h('div#viewer');
    this.viewer = new Viewer(viewerEl, {
      onRendered: (pv) => this.onPageRendered(pv),
      onLink: (pv, dest) => void this.goToDest(dest, pv.page.src),
    });
    this.tools = new Tools(this.viewer);
    this.sidebar = new Sidebar(this.viewer, this.tools, (dest) => void this.goToDest(dest, store.primary));
    this.search = new Search(this.viewer);
    const actions = {
      open: () => void this.openDialog(),
      save: () => void save(),
      print: () => void printDocument(),
      more: (a: HTMLElement) => this.moreMenu(a),
      search: () => (this.search.isOpen ? this.search.close() : this.search.open()),
      toggleSidebar: () => this.sidebar.toggle(),
      organize: () => this.organize(),
      chooseTool: (tool: Tool) => void this.chooseTool(tool),
      help: () => void helpDialog(),
    };
    this.topbar = new TopBar(this.viewer, actions);
    this.toolbar = new ToolBar(this.tools, actions);
    this.props = new PropsBar(this.tools, actions);
    this.badge = h('button#pageBadge', { type: 'button', title: t('goToPage'), onclick: () => void this.goToPagePrompt() });
    this.welcome = h('div#welcome');
    const viewerWrap = h('section#viewerWrap', {}, viewerEl, this.search.el, this.badge, this.welcome);
    const backdrop = h('div.side-backdrop', { onclick: () => this.sidebar.toggle(false) });
    this.dropOverlay = h('div#dropOverlay', { 'aria-hidden': 'true' }, h('div.drop-card', {}, icon(FolderOpen, 40), h('span')));
    this.root.append(this.topbar.el, this.toolbar.el, this.props.el, h('main#main', {}, this.sidebar.el, backdrop, viewerWrap), this.dropOverlay);

    installGestures(this.viewer, () => this.tools.tool === 'hand');
    this.tools.setTool('select');
    this.wireStore();
    this.wireViewer();
    this.wireKeyboard();
    this.wireDragDrop();
    this.wireLifecycle();
    void this.renderWelcome();
    this.topbar.update();
    void this.handleLaunch();
    let auto = false;
    try {
      auto = sessionStorage.getItem('pr.autorestore') === '1';
      sessionStorage.removeItem('pr.autorestore');
    } catch {
      /* ignore */
    }
    if (auto) void this.restore();
  }

  // ---------------- wiring ----------------

  private wireStore(): void {
    store.onChange((d) => {
      document.body.classList.toggle('has-doc', store.isOpen);
      if (d.kind === 'all' || d.kind === 'pages') {
        this.viewer.rebuild();
        this.search.invalidate();
        this.sidebar.render();
      } else if (d.kind === 'anns') {
        this.viewer.redrawOverlays(d.pageIds);
        if (!this.tools.isEditing()) this.sidebar.annotationsChanged();
      } else if (d.kind === 'form') {
        for (const v of this.viewer.order) v.syncForms();
      } else if (d.kind === 'doc') {
        this.viewer.redrawOverlays();
      }
      if (d.fromHistory) for (const v of this.viewer.order) v.syncForms();
      this.tools.refreshSelection();
      this.topbar.update();
      if (store.isOpen) scheduleSessionSave();
      if (!store.isOpen) void this.renderWelcome();
    });
  }

  private wireViewer(): void {
    this.viewer.addEventListener('pagechange', () => {
      if (!store.isOpen) return;
      this.badge.textContent = `${this.viewer.current + 1} ${t('pageOf')} ${store.state.pages.length}`;
      this.badge.classList.add('show');
      clearTimeout(this.badgeTimer);
      this.badgeTimer = window.setTimeout(() => this.badge.classList.remove('show'), 1200);
    });
  }

  private onPageRendered(pv: PageView): void {
    this.search.paint(pv);
  }

  private wireKeyboard(): void {
    document.addEventListener('keydown', (e) => {
      if (document.querySelector('.modal-backdrop, #organizer')) return;
      const target = e.target as HTMLElement;
      const typing = target.matches('input, textarea, select, [contenteditable]');
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'o') {
        e.preventDefault();
        void this.openDialog();
      } else if (mod && k === 's') {
        e.preventDefault();
        void save(e.shiftKey);
      } else if (mod && k === 'p') {
        e.preventDefault();
        void printDocument();
      } else if (mod && k === 'f') {
        if (!store.isOpen) return;
        e.preventDefault();
        this.search.open();
      } else if (typing) {
        return;
      } else if (!mod && !e.altKey && (e.key === '?' || e.key === 'F1')) {
        e.preventDefault();
        void helpDialog();
      } else if (!mod && !e.altKey && store.isOpen && e.key.length === 1 && TOOL_KEYS.has(e.key.toUpperCase())) {
        e.preventDefault();
        void this.chooseTool(TOOL_KEYS.get(e.key.toUpperCase())!);
      } else if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        store.redo();
      } else if (mod && (k === '=' || k === '+')) {
        e.preventDefault();
        this.viewer.zoomBy(1.2);
      } else if (mod && k === '-') {
        e.preventDefault();
        this.viewer.zoomBy(1 / 1.2);
      } else if (mod && k === '0') {
        e.preventDefault();
        this.viewer.setMode('auto');
      } else if (mod && k === 'd' && this.tools.selected) {
        e.preventDefault();
        this.tools.duplicateSelected();
      } else if ((k === 'delete' || k === 'backspace') && this.tools.selected) {
        e.preventDefault();
        this.tools.deleteSelected();
      } else if (k === 'escape') {
        if (this.tools.selected) this.tools.select(null);
        else if (this.tools.tool !== 'select') this.tools.setTool('select');
        else if (document.body.classList.contains('presenting')) this.togglePresentation(false);
      } else if (this.tools.selected && k.startsWith('arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        this.tools.nudge(k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0);
      } else if (store.isOpen && (k === 'pagedown' || (k === ' ' && !e.shiftKey && document.body.classList.contains('presenting')))) {
        if (document.body.classList.contains('presenting')) {
          e.preventDefault();
          this.viewer.scrollToPage(this.viewer.current + 1);
        }
      } else if (store.isOpen && k === 'pageup' && document.body.classList.contains('presenting')) {
        e.preventDefault();
        this.viewer.scrollToPage(this.viewer.current - 1);
      } else if (store.isOpen && document.body.classList.contains('presenting') && (k === 'arrowright' || k === 'arrowdown')) {
        e.preventDefault();
        this.viewer.scrollToPage(this.viewer.current + 1);
      } else if (store.isOpen && document.body.classList.contains('presenting') && (k === 'arrowleft' || k === 'arrowup')) {
        e.preventDefault();
        this.viewer.scrollToPage(this.viewer.current - 1);
      } else if (k === 'home' && store.isOpen) {
        e.preventDefault();
        this.viewer.scrollToPage(0);
      } else if (k === 'end' && store.isOpen) {
        e.preventDefault();
        this.viewer.scrollToPage(store.state.pages.length - 1);
      }
    });
  }

  private wireDragDrop(): void {
    let depth = 0;
    window.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      document.body.classList.add('dragging');
      this.dropOverlay.querySelector('span')!.textContent = store.isOpen ? t('dropToOpenOrInsert') : t('dropToOpen');
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) document.body.classList.remove('dragging');
    });
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      depth = 0;
      document.body.classList.remove('dragging');
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void this.handleFiles(files);
    });
  }

  private wireLifecycle(): void {
    window.addEventListener('beforeunload', (e) => {
      if (store.isOpen && store.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installPrompt = e as InstallPrompt;
      void this.renderWelcome();
    });
    window.addEventListener('appinstalled', () => {
      this.installPrompt = null;
      toast(t('installed'), 'success');
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) this.togglePresentation(false);
    });
  }

  /** Files passed by the OS ("Open with…") or shared from another app. */
  private async handleLaunch(): Promise<void> {
    void listenForSystemFiles((file) => void this.handleFiles([file])).catch((e) => console.warn('system files', e));
    const lq = (window as unknown as { launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void } }).launchQueue;
    lq?.setConsumer(async (params) => {
      if (!params.files?.length) return;
      const handle = params.files[0];
      const file = await handle.getFile();
      await this.openFile(file, handle);
    });
    const url = new URL(location.href);
    if (url.searchParams.has('shared')) {
      history.replaceState(null, '', url.pathname);
      try {
        const cache = await caches.open('pr-share');
        const res = await cache.match('shared-file');
        if (res) {
          const blob = await res.blob();
          const name = decodeURIComponent(res.headers.get('X-File-Name') || 'shared.pdf');
          await cache.delete('shared-file');
          await this.handleFiles([new File([blob], name, { type: blob.type })]);
        }
      } catch (e) {
        console.warn(e);
      }
    }
  }

  // ---------------- files ----------------

  async openDialog(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const picker = (window as unknown as { showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]> }).showOpenFilePicker;
    if (picker) {
      let handle: FileSystemFileHandle | undefined;
      try {
        [handle] = await picker({ types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }], multiple: false });
      } catch (e) {
        // Cancelled by the user; anything else (e.g. not allowed in an embedded page) falls back to the classic picker.
        if ((e as Error).name === 'AbortError') return;
      }
      if (handle) {
        await this.openFile(await handle.getFile(), handle);
        return;
      }
    }
    const files = await pickFiles('application/pdf,.pdf', false);
    if (files[0]) await this.openFile(files[0]);
  }

  private async confirmDiscard(): Promise<boolean> {
    if (!store.isOpen || !store.dirty) return true;
    return confirmDialog(t('unsavedChanges'), t('discard'), true);
  }

  async openFile(file: File, handle: FileSystemFileHandle | null = null): Promise<void> {
    busy(true);
    try {
      if (file.size > 150 * 1024 * 1024) toast(t('fileTooLarge'));
      const ok = await openBytes(await fileBytes(file), file.name, handle);
      if (ok) {
        this.afterOpen();
        await startSession();
      }
    } catch (e) {
      this.reportOpenError(e);
    } finally {
      busy(false);
    }
  }

  private reportOpenError(e: unknown): void {
    console.error(e);
    const msg = e instanceof NotPdfError ? (e as Error).message : t('errorOpen', { msg: (e as Error)?.message ?? String(e) });
    toast(msg, 'error', 6000);
  }

  private afterOpen(): void {
    this.sidebar.resetOutline();
    this.tools.setTool('select');
    this.viewer.current = 0;
    this.viewer.setMode('auto');
    this.viewer.scrollToPage(0);
    let wantSidebar = false;
    try {
      wantSidebar = localStorage.getItem('pr.sidebar') === '1';
    } catch {
      /* ignore */
    }
    if (window.innerWidth > 760 && wantSidebar) this.sidebar.toggle(true);
    this.topbar.update();
    this.firstRunTip();
  }

  /** One-time pointer to the tools and the help, shown with the first document. */
  private firstRunTip(): void {
    try {
      if (localStorage.getItem('pr.tipShown')) return;
      localStorage.setItem('pr.tipShown', '1');
    } catch {
      return;
    }
    setTimeout(() => toast(window.innerWidth <= 760 ? t('firstTipMobile') : t('firstTip'), 'info', 7000), 800);
  }

  /** Dropped/shared files: PDFs open (or get inserted), images become pages. */
  async handleFiles(files: File[]): Promise<void> {
    const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!pdfs.length && !images.length) {
      toast(t('notPdf'), 'error');
      return;
    }
    let insert = false;
    if (store.isOpen) {
      const r = await dialog<string>({
        title: t('appName'),
        body: h('p', {}, files.map((f) => f.name).join(', ')),
        actions: [
          { label: t('cancel'), value: 'cancel' },
          { label: t('insertFile'), value: 'insert' },
          { label: t('open'), value: 'open', primary: true },
        ],
        dismissValue: 'cancel',
      });
      if (r === 'cancel') return;
      insert = r === 'insert';
      if (!insert && !(await this.confirmDiscard())) return;
    }
    busy(true);
    try {
      if (insert) {
        for (const f of pdfs) await insertBytes(await fileBytes(f), f.name);
        if (images.length) await insertBytes(await imagesToPdfBytes(images), 'images.pdf');
        return;
      }
      const [first, ...rest] = pdfs;
      if (first) {
        const ok = await openBytes(await fileBytes(first), first.name);
        if (!ok) return;
        for (const f of rest) await this.appendQuiet(await fileBytes(f), f.name);
        if (images.length) await this.appendQuiet(await imagesToPdfBytes(images), 'images.pdf');
      } else {
        const ok = await openBytes(await imagesToPdfBytes(images), images.length === 1 ? images[0].name.replace(/\.[^.]+$/, '.pdf') : 'images.pdf');
        if (!ok) return;
        store.dirty = true;
      }
      this.afterOpen();
      await startSession();
    } catch (e) {
      this.reportOpenError(e);
    } finally {
      busy(false);
    }
  }

  /** Appends pages while building a new document (not recorded in history). */
  private async appendQuiet(bytes: Uint8Array, name: string): Promise<void> {
    const src = await addSource(bytes, name);
    if (!src) return;
    store.state.pages.push(...pagesOf(src));
    store.dirty = true;
    store.emit({ kind: 'pages' });
  }

  async newBlank(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    busy(true);
    try {
      if (await openBytes(await blankPdfBytes(), t('untitled'))) {
        store.dirty = true;
        this.afterOpen();
        await startSession();
      }
    } finally {
      busy(false);
    }
  }

  async imagesToPdf(): Promise<void> {
    const files = await pickFiles('image/*', true);
    if (files.length) await this.handleFiles(files);
  }

  async mergePdfs(): Promise<void> {
    const files = await pickFiles('application/pdf,.pdf', true);
    if (files.length) await this.handleFiles(files);
  }

  async restore(): Promise<void> {
    busy(true);
    try {
      const s = await loadSession();
      if (!s || !s.sources.length) {
        await clearSession();
        void this.renderWelcome();
        return;
      }
      store.reset();
      clearPages();
      clearText();
      clearThumbs();
      for (const src of s.sources) {
        const r = await addSource(src.bytes, src.name, src.id);
        if (!r) {
          store.reset();
          return;
        }
      }
      for (const a of s.assets) registerAsset(a, a.id);
      store.primary = s.primary;
      store.fileName = s.fileName;
      store.state = s.state;
      store.dirty = true;
      markRestored(
        s.sources.map((x) => x.id),
        s.assets.map((x) => x.id),
      );
      store.emit({ kind: 'all' });
      this.afterOpen();
    } catch (e) {
      this.reportOpenError(e);
    } finally {
      busy(false);
    }
  }

  async closeDocument(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.search.close();
    this.tools.setTool('select');
    store.reset();
    clearPages();
    clearText();
    clearThumbs();
    await clearSession();
    this.sidebar.toggle(false);
    void this.renderWelcome();
  }

  // ---------------- navigation ----------------

  private async goToPagePrompt(): Promise<void> {
    if (!store.isOpen) return;
    const v = await promptDialog(t('goToPage'), `${t('page')} (1–${store.state.pages.length})`, String(this.viewer.current + 1), 'number', t('goAction'));
    const n = v ? parseInt(v, 10) : NaN;
    if (Number.isFinite(n)) this.viewer.scrollToPage(n - 1);
  }

  async goToDest(dest: unknown, srcId: string | null): Promise<void> {
    if (!srcId) return;
    const src = store.sources.get(srcId);
    if (!src) return;
    try {
      let explicit = dest;
      if (typeof dest === 'string') explicit = await src.pdf.getDestination(dest);
      if (!Array.isArray(explicit)) return;
      const ref = explicit[0];
      const index = typeof ref === 'number' ? ref : await src.pdf.getPageIndex(ref);
      const i = store.state.pages.findIndex((p) => p.src === srcId && p.index === index);
      if (i < 0) return;
      const kind = (explicit[1] as { name?: string })?.name;
      const y = kind === 'XYZ' ? (explicit[3] as number | null) : kind === 'FitH' || kind === 'FitBH' ? (explicit[2] as number | null) : null;
      this.viewer.scrollToPage(i, typeof y === 'number' ? { userY: y } : {});
    } catch (e) {
      console.warn('bad destination', e);
    }
  }

  // ---------------- tools ----------------

  async chooseTool(tool: Tool): Promise<void> {
    if (!store.isOpen) return;
    if (tool === this.tools.tool && tool !== 'select' && !['image', 'signature', 'stamp'].includes(tool)) {
      this.tools.setTool('select');
      return;
    }
    this.tools.setTool(tool);
    if (tool === 'image') await insertImage(this.tools);
    else if (tool === 'signature') await signatureFlow(this.tools);
    else if (tool === 'stamp') await stampFlow(this.tools);
  }

  organize(): void {
    if (!store.isOpen) return;
    this.tools.setTool('select');
    openOrganizer((i) => {
      this.viewer.rebuild();
      this.viewer.scrollToPage(i);
    }, this.viewer.current);
  }

  togglePresentation(on = !document.body.classList.contains('presenting')): void {
    document.body.classList.toggle('presenting', on);
    if (on) {
      this.tools.setTool('hand');
      document.documentElement.requestFullscreen?.().catch(() => {});
      this.viewer.setMode('page');
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      this.tools.setTool('select');
      this.viewer.setMode('auto');
    }
  }

  // ---------------- menus ----------------

  private moreMenu(anchor: HTMLElement): void {
    const open = store.isOpen;
    const hasPicker = 'showSaveFilePicker' in window;
    const theme = this.theme();
    const items: MenuItem[] = [
      { section: t('secFile'), label: t('openPdf'), icon: FolderOpen, hint: `${MOD}O`, action: () => void this.openDialog() },
    ];
    if (open) {
      items.push(
        { label: t('save'), icon: Save, hint: `${MOD}S`, action: () => void save() },
        ...(hasPicker ? [{ label: t('saveAs'), icon: Save, hint: `${MOD}Shift+S`, action: () => void save(true) }] : []),
        { label: t('download'), icon: Download, action: () => void download() },
        ...(canShareFiles() ? [{ label: t('share'), icon: Share2, action: () => void share() }] : []),
        { label: t('print'), icon: Printer, hint: `${MOD}P`, action: () => void printDocument() },
      );
    }
    items.push(
      { label: t('createBlank'), icon: FilePlus, action: () => void this.newBlank() },
      { label: t('imagesToPdf'), icon: Images, action: () => void this.imagesToPdf() },
      { label: t('mergePdfs'), icon: Combine, action: () => void this.mergePdfs() },
    );
    if (open) {
      items.push(
        { label: t('closeDoc'), icon: X, action: () => void this.closeDocument() },
        { section: t('secDocument'), label: t('organize'), icon: LayoutGrid, action: () => this.organize() },
        {
          label: t('rotatePage'),
          icon: RotateCw,
          action: () => {
            const i = this.viewer.current;
            const p = store.state.pages[i];
            if (p) store.commit('pages', (s) => (s.pages[i] = { ...p, rot: ((p.rot + 90) % 360) as typeof p.rot }));
          },
        },
        { label: t('insertFile'), icon: FileStack, action: () => void this.insertFromFile() },
        { label: t('properties'), icon: Info, action: () => void propertiesDialog(this.viewer.current) },
        { label: t('protect'), icon: Lock, action: () => void protectDialog(), checked: !!store.protection },
        { label: t('watermark'), icon: Droplet, action: () => void watermarkDialog(), checked: !!store.state.watermark },
        { label: t('pageNumbers'), icon: Hash, action: () => void numberingDialog(), checked: !!store.state.numbering },
        { label: t('downloadFlattened'), icon: FileText, action: () => void this.saveFlattened() },
        { label: t('exportImages'), icon: FileImage, action: () => void exportImagesDialog(this.viewer.current) },
        { label: t('exportText'), icon: FileText, action: () => void exportText() },
        { section: t('secView'), label: t('readAloud'), icon: Volume2, action: () => readAloud(this.viewer, this.viewer.scroller.parentElement!) },
        { label: t('presentation'), icon: Maximize2, action: () => this.togglePresentation(true) },
        { label: t('nightMode'), icon: Moon, action: () => this.toggleNight(), checked: document.body.classList.contains('night') },
      );
    }
    items.push(
      {
        section: open ? undefined : t('secView'),
        label: `${t('theme')}: ${t(theme === 'dark' ? 'themeDark' : theme === 'light' ? 'themeLight' : 'themeAuto')}`,
        icon: SunMoon,
        action: () => this.cycleTheme(),
      },
      {
        label: `${t('language')}: ${LANGS.find((l) => l.code === getLang())?.name}`,
        icon: Languages,
        action: () => void this.switchLanguage(),
      },
      { section: t('secHelp'), label: t('help'), icon: CircleHelp, hint: '?', action: () => void helpDialog() },
      { label: t('authorName'), icon: User, action: () => void authorDialog() },
    );
    if (this.installPrompt) items.push({ label: t('installApp'), icon: MonitorDown, action: () => void this.install() });
    items.push({ label: t('about'), icon: Info, action: () => void aboutDialog() });
    openMenu(anchor, items);
  }

  private async insertFromFile(): Promise<void> {
    const files = await pickFiles('application/pdf,.pdf,image/*', true);
    if (!files.length) return;
    busy(true);
    try {
      let at = this.viewer.current + 1;
      const images = files.filter((f) => f.type.startsWith('image/'));
      for (const f of files.filter((f) => !f.type.startsWith('image/'))) at += await insertBytes(await fileBytes(f), f.name, at);
      if (images.length) await insertBytes(await imagesToPdfBytes(images), 'images.pdf', at);
    } catch (e) {
      this.reportOpenError(e);
    } finally {
      busy(false);
    }
  }

  private async saveFlattened(): Promise<void> {
    busy(true, t('saving'));
    try {
      const bytes = await exportPdf({ flattenForms: true });
      downloadBlob(new Blob([bytes.slice()], { type: 'application/pdf' }), suggestedName('-flat'));
    } catch (e) {
      toast(t('errorSave', { msg: (e as Error).message }), 'error');
    } finally {
      busy(false);
    }
  }

  private async install(): Promise<void> {
    const p = this.installPrompt;
    if (!p) return;
    this.installPrompt = null;
    await p.prompt();
    void this.renderWelcome();
  }

  private toggleNight(): void {
    document.body.classList.toggle('night');
  }

  private theme(): string {
    try {
      return localStorage.getItem('pr.theme') || 'auto';
    } catch {
      return 'auto';
    }
  }

  private applyTheme(): void {
    const pref = this.theme();
    const dark = pref === 'dark' || (pref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.lang = getLang();
    matchMedia('(prefers-color-scheme: dark)').onchange = () => this.theme() === 'auto' && this.applyTheme();
  }

  private cycleTheme(): void {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(this.theme()) + 1) % order.length];
    try {
      localStorage.setItem('pr.theme', next);
    } catch {
      /* ignore */
    }
    this.applyTheme();
  }

  private async switchLanguage(): Promise<void> {
    const i = LANGS.findIndex((l) => l.code === getLang());
    setLang(LANGS[(i + 1) % LANGS.length].code);
    // Reload in the new language; the open document comes back from the session store.
    if (store.isOpen) {
      await flushSession();
      try {
        sessionStorage.setItem('pr.autorestore', '1');
      } catch {
        /* ignore */
      }
    }
    store.dirty = false;
    location.reload();
  }

  // ---------------- welcome ----------------

  private async renderWelcome(): Promise<void> {
    if (store.isOpen) return;
    const session = await peekSession();
    if (store.isOpen) return;
    const openBtn = h('button.btn.btn-primary.btn-big', { type: 'button', onclick: () => void this.openDialog() }, icon(FolderOpen), t('openPdf'));
    const quick = (ic: Parameters<typeof icon>[0], label: string, fn: () => void) => h('button', { type: 'button', onclick: fn }, icon(ic, 24), h('span', {}, label));
    this.welcome.replaceChildren(
      h(
        'div.welcome-card',
        {},
        logo('hero-logo'),
        h('h1', {}, t('welcomeTitle')),
        h('p', {}, t('welcomeSub')),
        h('div.drop-zone', {}, h('p', { style: 'margin:0 0 12px' }, t('dropHint')), openBtn),
        h(
          'div.quick-actions',
          {},
          quick(FilePlus, t('createBlank'), () => void this.newBlank()),
          quick(Images, t('imagesToPdf'), () => void this.imagesToPdf()),
          quick(Combine, t('mergePdfs'), () => void this.mergePdfs()),
        ),
        session ? h('button.btn.restore-btn', { type: 'button', onclick: () => void this.restore() }, t('restoreSession', { name: session.fileName })) : null,
        h('button.link-btn', { type: 'button', onclick: () => void helpDialog() }, icon(CircleHelp, 16), t('helpTitle')),
        this.installPrompt ? h('button.btn.restore-btn', { type: 'button', onclick: () => void this.install() }, icon(MonitorDown), t('installApp')) : null,
      ),
    );
  }
}
