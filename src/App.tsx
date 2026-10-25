import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { CATEGORIES, THEMES, THEME_LABELS, chinaDay, fromChinaInput, toChinaInput, type ReminderSound, type Result, type Settings, type Task, type TaskInput, type ReminderMode, type ResizeEdge, type Theme } from '../electron/domain';
import ImportDialog from './ImportDialog';
import type { ImportedDocument } from '../electron/import-domain';

type Filter = 'pending' | 'today' | 'upcoming' | 'overdue' | 'done';
type Draft = { id?: string; sourceType?: 'text' | 'file'; title: string; dueAt: string; reminderAt: string; reminderTimes?: string[]; reminderMode: ReminderMode; category: Task['category']; notes: string; sourceText: string };
const emptyDraft = (): Draft => ({ title: '', dueAt: '', reminderAt: '', reminderMode: 'default', category: '其他', notes: '', sourceText: '' });
async function value<T>(promise: Promise<Result<T>>): Promise<T> { const result = await promise; if (!result.ok) throw new Error(result.error); return result.value; }
function errorText(error: unknown) { return error instanceof Error ? error.message : '操作失败，请重试'; }
function overdue(task: Task, now: number) { return !task.completed && !!task.dueAt && Date.parse(task.dueAt) < now; }
function timeLabel(date?: string) { return date ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date)) : '未设时间'; }
function draftFrom(input: TaskInput): Draft { return { id: input.id, sourceType: input.sourceType, title: input.title, dueAt: toChinaInput(input.dueAt || undefined), reminderAt: toChinaInput(input.reminderAt || undefined), reminderTimes: input.reminderTimes || undefined, reminderMode: input.reminderMode || 'default', category: input.category || '其他', notes: input.notes || '', sourceText: input.sourceText || '' }; }
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    settings: <><path d="m9 3 1-1h4l1 3 3 1 2 3-2 3-1 3-3 2h-4l-1-3-3-1-2-3 2-3Z"/><circle cx="12" cy="10" r="3"/></>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    down: <path d="m6 9 6 6 6-6"/>, up: <path d="m6 15 6-6 6 6"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
    edit: <><path d="m14 4 6 6M4 20l5-1L20 8l-5-5L4 14Z"/></>,
    trash: <><path d="M4 6h16M9 6V3h6v3M6 6l1 14h10l1-14M10 10v6M14 10v6"/></>,
    spark: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5Z"/></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>,
    bell: <><path d="M5 17h14l-2-4V9a5 5 0 0 0-10 0v4ZM10 21h4"/></>,
    pin: <><path d="m8 3 8 0-1 6 4 4H5l4-4ZM12 13v8"/></>,
    resize: <><path d="m7 20 13-13M13 20l7-7M19 20l1-1"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.check}</svg>;
}
function Modal({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}><section role="dialog" aria-modal="true" aria-label={title} className="modal"><header className="modal-head"><div><h2>{title}</h2><p>{subtitle}</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭对话框"><Icon name="close"/></button></header>{children}</section></div>;
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [filter, setFilter] = useState<Filter>('pending');
  const [category, setCategory] = useState('全部');
  const [search, setSearch] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('deepseek-flash');
  const [startAtLogin, setStartAtLogin] = useState(false);
  const [reminderSoundEnabled, setReminderSoundEnabled] = useState(true);
  const [theme, setTheme] = useState<Theme>('green');
  const [settingsStatus, setSettingsStatus] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [draftBusy, setDraftBusy] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [composerFocused, setComposerFocused] = useState(false);
  const [reminderPrompt, setReminderPrompt] = useState<Task | null>(null);
  const [reminderReply, setReminderReply] = useState('');
  const [reminderBusy, setReminderBusy] = useState(false);
  const [reminderError, setReminderError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [importSource, setImportSource] = useState<Promise<Result<ImportedDocument[]>> | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const importLocked = useRef(false);
  const dragStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const dragMoved = useRef(false);
  const resizePointer = useRef<number | null>(null);
  const reminderAudio = useRef<HTMLAudioElement | null>(null);

  const api = window.taskDesk;
  function startImport(source: () => Promise<Result<ImportedDocument[]>>) {
    if (importLocked.current || busy || settingsOpen || draft || reminderPrompt) return;
    importLocked.current = true; setDragOver(false); setStatus('');
    setImportSource(source());
  }
  function closeImport() { importLocked.current = false; setImportSource(null); }
  async function load() {
    try {
      const [allTasks, current] = await Promise.all([value(api.getTasks()), value(api.getSettings())]);
      setTasks(allTasks); setSettings(current); setModel(current.model); setStartAtLogin(current.startAtLogin); setReminderSoundEnabled(current.reminderSoundEnabled); setTheme(current.theme); setLoadFailed(false);
      if (current.firstRun) setSettingsOpen(true);
    } catch (error) { setStatus(errorText(error)); setLoadFailed(true); }
    finally { setLoaded(true); }
  }
  useEffect(() => {
    if (!api) return;
    void load();
    const offReminder = api.onReminder((task, sound?: ReminderSound) => {
      setTasks(current => current.some(item => item.id === task.id) ? current.map(item => item.id === task.id ? task : item) : [task, ...current]);
      setReminderPrompt(task);
      setReminderReply('');
      setReminderError('');
      if (sound?.dataUrl) {
        reminderAudio.current?.pause();
        const audio = new Audio(sound.dataUrl);
        audio.volume = 1;
        reminderAudio.current = audio;
        void audio.play().catch(() => setStatus(`任务提醒 · ${task.title}（提示音播放失败，请检查系统音量）`));
      }
      setStatus(`任务提醒 · ${task.title}${sound ? ` · 播放 ${sound.name}` : ''}${task.notes?.startsWith('Windows') ? ` · ${task.notes}` : ''}`);
    });
    const offSettings = api.onSettings(() => { setApiKey(''); setSettingsStatus(''); setSettingsOpen(true); });
    const offPaused = api.onPaused(paused => setSettings(current => current ? { ...current, paused } : current));
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => { offReminder(); offSettings(); offPaused(); clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!api) return;
    api.setKeepOpen(settingsOpen || !!draft || !!deleteId || !!reminderPrompt || composerFocused || !!input.trim() || busy || reminderBusy || !!importSource || dragOver);
    return () => api.setKeepOpen(false);
  }, [settingsOpen, draft, deleteId, reminderPrompt, composerFocused, input, busy, reminderBusy, importSource, dragOver]);
  useEffect(() => {
    if (!api) return;
    let depth = 0;
    const isFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes('Files');
    const enter = (event: DragEvent) => { if (isFiles(event)) { event.preventDefault(); depth++; if (!importLocked.current) setDragOver(true); } };
    const over = (event: DragEvent) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; };
    const leave = (event: DragEvent) => { if (isFiles(event)) { depth = Math.max(0, depth - 1); if (!depth) setDragOver(false); } };
    const drop = (event: DragEvent) => { event.preventDefault(); depth = 0; setDragOver(false); const files = Array.from(event.dataTransfer?.files || []); if (files.length) startImport(() => api.importDroppedFiles(files)); };
    const paste = (event: ClipboardEvent) => {
      if (Array.from(event.clipboardData?.items || []).some(item => item.type.startsWith('image/'))) { event.preventDefault(); startImport(() => api.importClipboardImage()); }
    };
    window.addEventListener('dragenter', enter); window.addEventListener('dragover', over); window.addEventListener('dragleave', leave); window.addEventListener('drop', drop); window.addEventListener('paste', paste);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); window.removeEventListener('paste', paste); };
  }, [busy, settingsOpen, draft, reminderPrompt]);

  function handleDragStart(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('button, input, textarea, select, a')) return;
    dragStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    dragMoved.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
    api.startDragWindow();
  }
  function handleDragMove(event: ReactPointerEvent<HTMLElement>) {
    const start = dragStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - start.x) > 4 || Math.abs(event.clientY - start.y) > 4) dragMoved.current = true;
    api.moveDragWindow();
  }
  function handleDragEnd(event: ReactPointerEvent<HTMLElement>) {
    if (!dragStart.current || dragStart.current.pointerId !== event.pointerId) return;
    api.endDragWindow();
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Pointer capture may already be released. */ }
    dragStart.current = null;
  }
  function handleHandleClick(event: React.MouseEvent<HTMLButtonElement>) {
    if (dragMoved.current) { event.preventDefault(); event.stopPropagation(); dragMoved.current = false; return; }
    api.toggleWindow();
  }
  function handleResizeStart(event: ReactPointerEvent<HTMLElement>, edge: ResizeEdge) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizePointer.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    api.startResizeWindow(edge);
  }
  function handleResizeMove(event: ReactPointerEvent<HTMLElement>) {
    if (resizePointer.current === event.pointerId) api.moveResizeWindow();
  }
  function handleResizeEnd(event: ReactPointerEvent<HTMLElement>) {
    if (resizePointer.current !== event.pointerId) return;
    resizePointer.current = null;
    api.endResizeWindow();
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Capture may already be released. */ }
  }
  async function resetWindowSize() {
    try { await value(api.resetWindowSize()); setSettingsStatus('窗口已恢复默认大小。也可以拖动右侧、底边或右下角调整。'); }
    catch (error) { setSettingsStatus(errorText(error)); }
  }

  const pending = tasks.filter(task => !task.completed);
  const counts = { pending: pending.length, today: pending.filter(task => !!task.dueAt && chinaDay(task.dueAt) === chinaDay(now)).length, upcoming: pending.filter(task => !!task.dueAt && Date.parse(task.dueAt) >= now && chinaDay(task.dueAt) > chinaDay(now)).length, overdue: pending.filter(task => overdue(task, now)).length, done: tasks.length - pending.length };
  const visible = useMemo(() => tasks.filter(task => {
    const match = filter === 'done' ? task.completed : !task.completed && (filter === 'pending' || (filter === 'today' && !!task.dueAt && chinaDay(task.dueAt) === chinaDay(now)) || (filter === 'upcoming' && !!task.dueAt && Date.parse(task.dueAt) >= now && chinaDay(task.dueAt) > chinaDay(now)) || (filter === 'overdue' && overdue(task, now)));
    return match && (category === '全部' || task.category === category) && (!search.trim() || `${task.title} ${task.notes} ${task.sourceText}`.toLowerCase().includes(search.trim().toLowerCase()));
  }).sort((a,b) => (Date.parse(a.dueAt || '2999-01-01') - Date.parse(b.dueAt || '2999-01-01')) || b.createdAt.localeCompare(a.createdAt)), [tasks, filter, category, search, now]);

  async function addWithAI() {
    const source = input.trim();
    if (!source || busy || draft || settingsOpen || importLocked.current) return;
    setBusy(true); setStatus('');
    try {
      const parsed = await value(api.parseTask(source));
      const saved = await value(api.saveTask(parsed));
      setTasks(current => [saved, ...current]); setInput(''); setFilter('pending'); setCategory('全部'); setSearch('');
      setStatus(saved.reminderAt && Date.parse(saved.reminderAt) <= Date.now() ? '任务已添加 · 提醒时间已到，将立即提醒' : '已整理为任务，安排好了。');
    } catch (error) {
      // Never save a failed parse silently. Keep both the input and editable draft.
      setDraft({ ...emptyDraft(), title: source.slice(0, 500), sourceText: source });
      setDraftError(`${errorText(error)}。原文已保留，请确认内容和时间后保存。`);
    } finally { setBusy(false); }
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault(); if (!draft || draftBusy) return;
    setDraftBusy(true); setDraftError('');
    try {
      const saved = await value(api.saveTask({ ...draft, dueAt: fromChinaInput(draft.dueAt), reminderAt: draft.reminderMode === 'custom' ? fromChinaInput(draft.reminderAt) : undefined, reminderTimes: draft.reminderTimes }));
      setTasks(current => draft.id ? current.map(task => task.id === saved.id ? saved : task) : [saved, ...current]);
      if (!draft.id && draft.sourceText && draft.sourceText === input.trim()) setInput('');
      setDraft(null); setStatus(draft.id ? '任务已更新' : '任务已添加');
    } catch (error) { setDraftError(errorText(error)); }
    finally { setDraftBusy(false); }
  }
  async function toggle(task: Task) {
    try { const saved = await value(api.toggleTask(task.id, !task.completed)); setTasks(current => current.map(item => item.id === saved.id ? saved : item)); setStatus(saved.completed ? '做得好，又完成了一件事。' : '任务已恢复为待办'); }
    catch (error) { setStatus(errorText(error)); }
  }
  async function deleteTask() {
    if (!deleteId) return;
    try { await value(api.deleteTask(deleteId)); setTasks(current => current.filter(task => task.id !== deleteId)); setDeleteId(null); setStatus('任务已删除'); }
    catch (error) { setStatus(errorText(error)); }
  }
  async function submitReminderResponse(event: FormEvent) {
    event.preventDefault();
    if (!reminderPrompt || reminderBusy) return;
    const response = reminderReply.trim();
    if (!response) { setReminderError('请用自己的话回复，说明是否已处理，或什么时候再提醒。'); return; }
    setReminderBusy(true); setReminderError('');
    try {
      const saved = await value(api.respondReminder(reminderPrompt.id, response));
      setTasks(current => current.map(item => item.id === saved.id ? saved : item));
      setReminderPrompt(null); setReminderReply('');
      setStatus(saved.completed ? '已收到回复，任务完成。' : `已安排下次提醒：${timeLabel(saved.reminderAt)}`);
    } catch (error) { setReminderError(errorText(error)); }
    finally { setReminderBusy(false); }
  }
  async function saveSettings(event?: FormEvent) {
    event?.preventDefault(); if (settingsBusy) return;
    setSettingsBusy(true); setSettingsStatus('');
    try {
      const saved = await value(api.saveSettings({ apiKey: apiKey.trim() || undefined, model: model.trim(), startAtLogin, reminderSoundEnabled, theme }));
      setSettings(saved); setApiKey(''); setSettingsOpen(false); setStatus(saved.hasApiKey ? '设置已保存，可以开始添加任务了' : '设置已保存，随时可以手动添加任务');
    } catch (error) { setSettingsStatus(errorText(error)); }
    finally { setSettingsBusy(false); }
  }
  async function testKey() {
    setSettingsBusy(true); setSettingsStatus('正在测试 Key 和模型连接…');
    try { await value(api.testApiKey({ apiKey: apiKey.trim() || undefined, model: model.trim() })); setSettingsStatus('连接成功！Key 和模型可用。'); }
    catch (error) { setSettingsStatus(errorText(error)); }
    finally { setSettingsBusy(false); }
  }
  async function clearKey() {
    setSettingsBusy(true);
    try { const saved = await value(api.saveSettings({ apiKey: '' })); setSettings(saved); setApiKey(''); setSettingsStatus('已删除本机保存的 API Key'); }
    catch (error) { setSettingsStatus(errorText(error)); }
    finally { setSettingsBusy(false); }
  }
  function openDraft(task?: Task) { setDraft(task ? draftFrom(task) : { ...emptyDraft(), title: input.trim().slice(0, 500), sourceText: input.trim() }); setDraftError(''); }
  if (!api) return <div className="browser-fallback"><strong>请从桌面应用打开轻任务</strong><p>开发时运行 npm run dev，或安装 Windows 安装包。</p></div>;

  return <div className={`app-shell theme-${theme}`}>
    <section className="panel">
      <header className="titlebar" onPointerDown={handleDragStart} onPointerMove={handleDragMove} onPointerUp={handleDragEnd} onPointerCancel={handleDragEnd}><div className="brand"><div className="brand-mark"><Icon name="check" size={24}/></div><div><h1>轻任务<span>DESKTOP PLANNER</span></h1><p>把事情放下来，让每一天更轻一点。</p></div></div><div className="title-actions"><button className="icon-button" aria-label="设置" onClick={() => { setSettingsStatus(''); setSettingsOpen(true); }}><Icon name="settings"/></button><button className="icon-button" aria-label="收起窗口" onClick={() => api.hideWindow()}><Icon name="up"/></button></div></header>
      <div className="overview"><div><span className="eyebrow">YOUR DAY, AT A GLANCE</span><div className="date-line">{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(now))}</div></div><div className="today-count"><strong>{counts.today.toString().padStart(2,'0')}</strong><span>今日待办</span></div></div>
      <nav className="filter-tabs" aria-label="任务状态">{([['pending','全部待办'], ['today','今天'], ['upcoming','即将到期'], ['overdue','逾期'], ['done','已完成']] as const).map(([key,label]) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}<span className={key === 'overdue' && counts.overdue ? 'red' : ''}>{counts[key]}</span></button>)}</nav>
      <div className="toolbar"><div className="category-row">{['全部',...CATEGORIES].map(item => <button className={category === item ? 'selected' : ''} onClick={() => setCategory(item)} key={item}>{item}</button>)}</div><label className="search"><Icon name="search" size={14}/><input aria-label="搜索任务" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索任务"/></label></div>
      <main className="task-list" aria-label="任务列表">
        {!loaded ? <div className="empty"><div className="empty-icon"><Icon name="clock" size={28}/></div><h2>正在打开你的计划…</h2></div> : visible.length === 0 ? <div className="empty"><div className="empty-illustration"><span className="mini-line"/><span className="mini-line short"/><span className="mini-check"><Icon name="check" size={21}/></span></div><h2>{loadFailed ? '任务暂时无法读取' : search || category !== '全部' ? '没有找到相关任务' : filter === 'done' ? '每一步完成，都值得记录' : filter === 'overdue' ? '没有逾期的事情' : '留一点空间，给接下来的计划'}</h2><p>{loadFailed ? status : '一句话记下来，剩下的交给轻任务。'}</p>{loadFailed ? <button className="text-button" onClick={() => void load()}>重新读取</button> : <button className="text-button" onClick={() => openDraft()}>创建第一条任务 <Icon name="arrow" size={14}/></button>}</div> : visible.map(task => <article key={task.id} className={`task-card ${task.completed ? 'completed' : ''} ${overdue(task,now) ? 'overdue' : ''}`}><button className="check" aria-label={`${task.completed ? '恢复' : '完成'}：${task.title}`} onClick={() => void toggle(task)}>{task.completed && <Icon name="check" size={13}/>}</button><div className="task-body"><div className="task-title">{task.title}</div><div className="task-meta"><span className={`tag category-${task.category}`}>{task.category}</span><span className="task-time"><Icon name="clock" size={12}/>{timeLabel(task.dueAt)}{overdue(task,now) && ' · 已逾期'}</span></div>{task.reminderAt && <div className="reminder-line"><Icon name="bell" size={11}/> {timeLabel(task.reminderAt)} 提醒</div>}{task.notes && <p className="task-notes">{task.notes}</p>}</div><div className="task-actions"><button className="icon-button" aria-label={`编辑：${task.title}`} onClick={() => openDraft(task)}><Icon name="edit" size={14}/></button><button className="icon-button" aria-label={`删除：${task.title}`} onClick={() => setDeleteId(task.id)}><Icon name="trash" size={14}/></button></div></article>)}
      </main>
      <footer className="composer-area"><div className="composer-label"><span><Icon name="spark" size={14}/> 一句话，安排好</span><div className="composer-tools"><button className="text-button" onClick={() => startImport(() => api.chooseImportFiles())} disabled={busy}>导入文件</button><button className="text-button" onClick={() => startImport(() => api.importClipboardImage())} disabled={busy} title="也可以直接按 Ctrl+V 粘贴截图">粘贴截图</button><button className="text-button" onClick={() => openDraft()} disabled={busy}><Icon name="plus" size={12}/> 手动添加</button></div></div><div className={`composer ${busy ? 'busy' : ''}`}><textarea aria-label="自然语言任务" aria-keyshortcuts="Enter Shift+Enter" placeholder="比如：明天下午 3 点开会，提前 10 分钟提醒" value={input} maxLength={4000} onFocus={() => setComposerFocused(true)} onBlur={() => setComposerFocused(false)} onChange={event => setInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (!event.repeat) void addWithAI(); } }} rows={2}/><div className="composer-bottom"><span>{busy ? '正在理解你的安排…' : 'Enter 发送 · Shift+Enter 换行'}</span><button className="add-button" onClick={() => void addWithAI()} disabled={busy || !input.trim() || loadFailed}>{busy ? <span className="spinner"/> : <Icon name="plus" size={15}/>} {busy ? '整理中' : '添加任务'}</button></div></div><div className="status-line" role="status">{status || <><span className="local-dot"/>仅保存在本机 <span className="shortcut">拖动右下角调整大小</span></>}</div></footer>
      <div className="panel-footer"><span><span className={`connection-dot ${settings?.hasApiKey ? 'connected' : ''}`}/>{settings?.hasApiKey ? 'DeepSeek 已连接' : '手动记录模式'}</span><button onClick={async () => { try { const paused = await value(api.setPaused(!settings?.paused)); setSettings(current => current ? { ...current, paused } : current); } catch (error) { setStatus(errorText(error)); } }}><Icon name="pin" size={11}/>{settings?.paused ? '已固定展开' : '贴边自动隐藏'}</button></div>
    </section>
    <button className="edge-handle" aria-label="展开或收起任务窗口" onPointerDown={handleDragStart} onPointerMove={handleDragMove} onPointerUp={handleDragEnd} onPointerCancel={handleDragEnd} onClick={handleHandleClick}><span className="handle-dot"/>轻任务<span className="handle-grip">•••</span></button>
    {([['right', '调整窗口宽度'], ['bottom', '调整窗口高度'], ['bottom-right', '调整窗口宽高']] as const).map(([edge, label]) => <div key={edge} className={`resize-handle resize-${edge}`} title={label} aria-label={label} onPointerDown={event => handleResizeStart(event, edge)} onPointerMove={handleResizeMove} onPointerUp={handleResizeEnd} onPointerCancel={handleResizeEnd} onLostPointerCapture={handleResizeEnd}>{edge === 'bottom-right' && <Icon name="resize" size={15}/>}</div>)}

    {dragOver && !importSource && <div className="file-drop-overlay"><div><strong>松开，把通知交给轻任务</strong><p>PDF · Word · 截图 · TXT / Markdown / CSV</p><span>一次最多 8 个文件，每个不超过 20 MB</span></div></div>}
    {importSource && <ImportDialog source={importSource} hasKey={!!settings?.hasApiKey} onClose={closeImport} onSaved={saved => {
      setTasks(current => [...saved, ...current]); closeImport(); setFilter('pending'); setCategory('全部'); setSearch('');
      setStatus(`已导入 ${saved.length} 条待办，提醒已按预览安排。`);
    }}/>}
    {settingsOpen && <Modal title={settings?.firstRun ? '欢迎使用轻任务' : '偏好设置'} subtitle="粘贴自己的 DeepSeek Key，即可用一句话安排任务。" onClose={() => { if (!settings?.firstRun) { setSettingsOpen(false); setApiKey(''); } else void saveSettings(); }}>
      <form onSubmit={event => void saveSettings(event)}>
        <label>DeepSeek API Key<input autoFocus type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={settings?.hasApiKey ? '已加密保存，留空保持不变' : '在这里粘贴你的 API Key'}/></label>
        <div className="model-row"><label>模型<input value={model} onChange={event => setModel(event.target.value)} required maxLength={100}/></label><button type="button" className="secondary" disabled={settingsBusy || (!apiKey && !settings?.hasApiKey)} onClick={() => void testKey()}>{settingsBusy ? '请稍候…' : '测试连接'}</button></div>
        <label className="checkbox-label"><input type="checkbox" checked={startAtLogin} onChange={event => setStartAtLogin(event.target.checked)}/> 开机时自动启动到系统托盘</label>
        <label className="checkbox-label"><input type="checkbox" checked={reminderSoundEnabled} onChange={event => setReminderSoundEnabled(event.target.checked)}/> 开启提醒提示音</label>
        <div className="sound-folder-row"><p className="field-hint sound-hint">内置“冰、牛、哇哦”三个提示音。可放入自己的 .wav、.mp3 等音频，按文件名依次循环；文件夹为空时使用内置音频。</p><button type="button" className="secondary" onClick={async () => { try { await value(api.openReminderAudioFolder()); setSettingsStatus('音频文件夹已打开，可添加或替换提示音。'); } catch (error) { setSettingsStatus(errorText(error)); } }}>打开音频文件夹</button></div>
        <div className="theme-picker"><span className="theme-picker-label">主题颜色</span><div className="theme-options" role="radiogroup" aria-label="主题颜色">{THEMES.map(item => <button key={item} type="button" role="radio" className={`theme-option theme-option-${item} ${theme === item ? 'selected' : ''}`} aria-checked={theme === item} onClick={() => setTheme(item)}><span className="theme-swatch"/>{THEME_LABELS[item]}</button>)}</div></div>
        <div className="window-size-options"><p>拖动右侧调宽、底边调高，或拖动右下角同时调整宽高。尺寸会自动保存。</p><button type="button" className="secondary" onClick={() => void resetWindowSize()}>恢复默认大小</button></div>
        <div className="settings-note"><Icon name="check" size={15}/><p>Key 通过 Windows 本机加密保存。任务保存在本地；使用 AI 时会发送任务描述或导入文件中提取的文字。</p></div>
        {settings?.hasApiKey && <button type="button" className="danger-text" disabled={settingsBusy} onClick={() => void clearKey()}>删除本机保存的 Key</button>}
        <p className="form-message" role="status">{settingsStatus}</p>
        <div className="modal-actions"><span>也可以先不配置，手动使用。</span><button type="submit" className="primary" disabled={settingsBusy}>{settings?.firstRun ? '开始使用' : '保存设置'}</button></div>
      </form>
    </Modal>}
    {draft && <Modal title={draft.id ? '编辑任务' : '添加任务'} subtitle="所有时间均为北京时间（UTC+8）。" onClose={() => { if (!draftBusy) setDraft(null); }}><form onSubmit={event => void saveDraft(event)} className="draft-form"><label>任务名称<input autoFocus required maxLength={500} value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })}/></label><div className="field-row"><label>截止时间<input type="datetime-local" value={draft.dueAt} onChange={event => setDraft({ ...draft, dueAt: event.target.value })}/></label><label>分类<select value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value as Task['category'] })}>{CATEGORIES.map(item => <option key={item}>{item}</option>)}</select></label></div><label>提醒<select value={draft.reminderMode} disabled={!draft.dueAt} onChange={event => setDraft({ ...draft, reminderMode: event.target.value as ReminderMode })}><option value="default">提前 1 小时（默认）</option><option value="custom">指定提醒时间</option><option value="none">不提醒</option></select></label>{draft.dueAt && draft.reminderMode === 'custom' && <label>提醒时间<input type="datetime-local" required value={draft.reminderAt} onChange={event => setDraft({ ...draft, reminderAt: event.target.value })}/></label>}<label>备注<textarea rows={2} maxLength={4000} value={draft.notes} onChange={event => setDraft({ ...draft, notes: event.target.value })}/></label>{draft.sourceText && <details className="source-text"><summary>查看原始输入</summary><p>{draft.sourceText}</p></details>}{!draft.dueAt && <p className="field-hint">没有截止时间时不提醒。</p>}<p className="form-message error" role="alert">{draftError}</p><div className="modal-actions"><button type="button" className="secondary" disabled={draftBusy} onClick={() => setDraft(null)}>取消</button><button type="submit" className="primary" disabled={draftBusy}>{draftBusy ? '保存中…' : '保存任务'}</button></div></form></Modal>}
    {reminderPrompt && <Modal title="该行动啦" subtitle="用普通话回复就可以，轻任务会理解你的意思。" onClose={() => { if (!reminderBusy) { setReminderPrompt(null); setReminderReply(''); setReminderError(''); } }}><div className="reminder-prompt"><strong>{reminderPrompt.title}</strong><p>可以回复“好的”“收到，我马上处理”或“hao”；如果还没做，直接说“半小时后再提醒我”或“明天上午9点提醒我”。</p></div><form onSubmit={event => void submitReminderResponse(event)}><label>你的回复<input autoFocus value={reminderReply} onChange={event => setReminderReply(event.target.value)} placeholder="例如：好的，或半小时后再提醒我" maxLength={500}/></label><p className="form-message error" role="alert">{reminderError}</p><div className="modal-actions"><button type="button" className="secondary" disabled={reminderBusy} onClick={() => { setReminderPrompt(null); setReminderReply(''); setReminderError(''); }}>暂不回复（5分钟后提醒）</button><button type="submit" className="primary" disabled={reminderBusy}>{reminderBusy ? '理解中…' : '确认回复'}</button></div></form></Modal>}
    {deleteId && <Modal title="删除这条任务？" subtitle="删除后无法恢复。" onClose={() => setDeleteId(null)}><p className="delete-title">{tasks.find(task => task.id === deleteId)?.title}</p><div className="modal-actions"><button className="secondary" onClick={() => setDeleteId(null)}>取消</button><button className="danger" onClick={() => void deleteTask()}>删除任务</button></div></Modal>}
  </div>;
}
