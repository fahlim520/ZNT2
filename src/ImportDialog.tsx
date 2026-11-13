import { useEffect, useRef, useState } from 'react';
import { CATEGORIES, fromChinaInput, normalizeInput, toChinaInput, type Task, type TaskInput } from '../electron/domain';
import { IMPORT_LIMITS, type ImportedDocument, type ImportCandidate, type CampusAssessment } from '../electron/import-domain';
import type { NoticeMatch, ImportSaveInput, ImportSaveResult } from '../electron/notice-review';

type Row = { id: string; selected: boolean; task: TaskInput; due: string; reminder: string; warnings: string[]; evidence: string; assessment?: CampusAssessment; match?: NoticeMatch; forceCreate?: boolean };
const assessmentLabels = { related: '与你相关', uncertain: '需要补充确认', unrelated: '适用条件可能不符', general: '公共事项' };
const errorText = (error: unknown) => error instanceof Error ? error.message : '导入失败，请重试';
const timeLabel = (date?: string | null) => date ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(date)) : '未设时间';
async function result<T>(promise: Promise<import('../electron/domain').Result<T>>) { const r = await promise; if (!r.ok) throw new Error(r.error); return r.value; }
function row(candidate: ImportCandidate): Row { return { ...candidate, selected: !candidate.match && !candidate.warnings.some(item => /重复任务/.test(item)), due: toChinaInput(candidate.task.dueAt || undefined), reminder: toChinaInput(candidate.task.reminderAt || undefined) }; }

export default function ImportDialog({ source, hasKey, onClose, onSaved }: { source: Promise<import('../electron/domain').Result<ImportedDocument[]>>; hasKey: boolean; onClose: () => void; onSaved: (result: ImportSaveResult) => void }) {
  const api = window.taskDesk;
  const [documents, setDocuments] = useState<ImportedDocument[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [phase, setPhase] = useState<'extract' | 'parse' | 'save' | 'ready'>('extract');
  const [message, setMessage] = useState('正在读取文件…');
  const [error, setError] = useState('');
  const [active, setActive] = useState('');
  const [clarification, setClarification] = useState('');
  const [replacePending, setReplacePending] = useState(false);
  const alive = useRef(true);
  const initialized = useRef(false);
  const activeDoc = documents.find(document => document.id === active);
  const busy = phase !== 'ready';
  const selected = rows.filter(row => row.selected);
  const updates = selected.filter(row => row.match?.kind === 'update' && !row.forceCreate).length;
  const questions = rows.some(row => row.assessment?.questions.length);

  async function parse(docs = documents) {
    setPhase('parse'); setError(''); setMessage('正在整理待办…');
    try {
      const parsed = await result(api.parseImportedDocuments(docs.filter(document => !document.error), clarification.trim() || undefined));
      if (!alive.current) return;
      setRows(parsed.map(row));
      setMessage(parsed.length ? `找到 ${parsed.length} 条事项，请核对内容和时间后加入待办。` : '没有找到明确的行动事项，可以根据原文手动创建。');
    } catch (error) { if (alive.current) { setError(errorText(error)); setMessage('原文已保留，可以重新整理或手动创建。'); } }
    finally { if (alive.current) setPhase('ready'); }
  }

  useEffect(() => {
    alive.current = true;
    const off = api.onImportProgress(progress => setMessage(progress.message));
    if (!initialized.current) {
      initialized.current = true;
      void result(source).then(async docs => {
        if (!alive.current) return;
        if (!docs.length) { onClose(); return; }
        setDocuments(docs); setActive(docs.find(document => !document.error)?.id || docs[0].id);
        if (hasKey && docs.some(document => !document.error && document.text)) await parse(docs);
        else { setPhase('ready'); setMessage(hasKey ? '文件未识别到可用文字，请查看文件提示。' : '本地文字提取完成。未配置 Key，可以按原文手动创建任务。'); }
      }).catch(error => { if (alive.current) { setError(errorText(error)); setPhase('ready'); setMessage('请关闭后重新选择文件。'); } });
    }
    return () => { alive.current = false; off(); };
  }, []);

  function close() { if (phase === 'save') return; alive.current = false; api.cancelImport(); onClose(); }
  function update(id: string, patch: Partial<Row>) { setRows(current => current.map(item => item.id === id ? { ...item, ...patch } : item)); }
  function updateTask(item: Row, patch: Partial<TaskInput>) { update(item.id, { task: { ...item.task, ...patch } }); }
  function manual() {
    if (rows.length >= IMPORT_LIMITS.tasks) return;
    const document = activeDoc && !activeDoc.error ? activeDoc : documents.find(document => !document.error);
    const evidence = document?.text.slice(0, 1600) || '';
    setRows(current => [...current, { id: `manual-${Date.now()}`, selected: true, due: '', reminder: '', warnings: ['手动创建，请填写任务和时间。'], evidence,
      task: { title: '', sourceType: 'file', reminderMode: 'none', category: '学习', notes: document ? `来源：${document.name}` : '', sourceText: document ? `【${document.name}】\n${evidence}` : '' } }]);
  }
  async function save() {
    if (!selected.length || busy) return;
    setError('');
    let inputs: ImportSaveInput[];
    try {
      inputs = selected.map((item, index) => {
        try { return { task: normalizeInput({ ...item.task, dueAt: fromChinaInput(item.due), reminderAt: item.task.reminderMode === 'custom' ? fromChinaInput(item.reminder) : undefined }), candidateId: item.id, action: item.match?.kind === 'update' && !item.forceCreate ? 'update' : 'create', forceCreate: item.forceCreate }; }
        catch (error) { throw new Error(`第 ${index + 1} 条已选任务：${errorText(error)}`); }
      });
    } catch (error) { setError(errorText(error)); return; }
    setPhase('save');
    try { onSaved(await result(api.saveImportedTasks(inputs))); }
    catch (error) { setError(errorText(error)); setPhase('ready'); }
  }

  return <div className="modal-backdrop import-backdrop" onKeyDown={event => { if (event.key === 'Escape') close(); }}>
    <section className="modal import-modal" role="dialog" aria-modal="true" aria-label="文件转待办">
      <header className="modal-head"><div><h2>把通知变成待办</h2><p>识别 → 核对 → 加入任务 · 北京时间</p></div><button className="icon-button" onClick={close} disabled={phase === 'save'} aria-label="关闭文件导入">×</button></header>
      <details className="import-privacy"><summary>AI 如何使用这些信息</summary><p>文件先在本地提取文字；配置 Key 后，文字、本次补充和已有文件任务的标题、日期及来源摘录会发给 DeepSeek，用于整理、去重和判断补充通知（每次最多对照 60 条）。手动任务和个人备注不参与对照。若允许 AI 使用校园资料，还会附上校园资料；原件和图片不上传。</p></details>
      <div className="import-progress" role="status">{busy && <span className="spinner"/>}{message}</div>
      {documents.length > 0 && <div className="import-documents">
        <label>来源文件<select aria-label="来源文件" value={active} onChange={event => setActive(event.target.value)}>{documents.map(document => <option key={document.id} value={document.id}>{document.name}{document.error ? ' · 读取失败' : ''}</option>)}</select></label>
        {activeDoc && <><div className="import-warnings">{activeDoc.error && <p className="error">{activeDoc.error}</p>}{activeDoc.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>
          {!activeDoc.error && <details><summary>查看或修正识别原文（{activeDoc.text.length} 字）</summary><textarea aria-label="识别原文" rows={6} value={activeDoc.text} maxLength={IMPORT_LIMITS.text} disabled={busy} onChange={event => { setDocuments(current => current.map(document => document.id === active ? { ...document, text: event.target.value } : document)); }}/><p className="field-hint">修改原文后点击“重新整理”。Word 内嵌图片请单独保存为截图导入。</p></details>}</>}
        <details className="import-clarification"><summary>{questions ? '有模糊信息，可选补充' : '补充说明（选填）'}</summary><label>本次补充 <span className="optional">选填</span><textarea aria-label="本次补充" rows={2} value={clarification} maxLength={2000} disabled={busy} onChange={event => setClarification(event.target.value)} placeholder="回答需要确认的问题，或说明通知的发布日期。"/></label>
        <p className="field-hint">填写后重新整理，AI 会结合回答再次判断。补充只用于本次导入，不会改写校园资料。</p>
        </details>
        <div className="import-tools"><button type="button" className="secondary" disabled={busy || !hasKey || !documents.some(document => document.text && !document.error)} onClick={() => { if (rows.length) setReplacePending(true); else void parse(); }}>{rows.length ? '结合补充重新整理' : 'AI 整理待办'}</button><button type="button" className="secondary" disabled={busy || rows.length >= IMPORT_LIMITS.tasks} onClick={manual}>手动创建一条</button></div>
        {replacePending && <div className="import-reparse"><p>重新整理会替换本次预览中的编辑和勾选；已保存任务不受影响。</p><button className="secondary" disabled={busy} onClick={() => setReplacePending(false)}>保留当前预览</button><button className="primary" disabled={busy} onClick={() => { setReplacePending(false); void parse(); }}>重新整理</button></div>}
      </div>}
      {rows.length > 0 && <><div className="import-selection"><strong>{rows.length} 条事项 · 已选 {selected.length} 条</strong><button className="text-button" disabled={busy} onClick={() => setRows(current => current.map(item => ({ ...item, selected: false })))}>取消勾选</button></div>
        <p className="field-hint">模糊信息会通知你，补充与否由你决定，未填时间也可保存待办。已有提醒不重复创建；改期仍需单独确认。</p>
        {rows.map((item, index) => <article key={item.id} className={`import-task ${item.selected ? 'selected' : ''}`}>
          <div className="import-task-head"><label className="checkbox-label"><input aria-label={`选择第${index + 1}条任务`} type="checkbox" disabled={busy || (item.match?.kind === 'duplicate' && !item.forceCreate)} checked={item.selected} onChange={event => update(item.id, { selected: event.target.checked })}/> {item.match && !item.forceCreate ? item.match.kind === 'update' ? '确认更新原任务时间' : '已有这条提醒' : `第 ${index + 1} 条`}</label><button className="danger-text" disabled={busy} onClick={() => setRows(current => current.filter(row => row.id !== item.id))}>移除</button></div>
          {item.match && <div className={`notice-match notice-${item.match.kind}`}><strong>{item.match.title}{item.match.completed ? ' · 已完成' : ''}</strong><p>{item.match.reason}</p>{item.match.kind === 'update' ? <><p>原截止：{timeLabel(item.match.dueAt)}<br/>新截止：{timeLabel(fromChinaInput(item.due))}</p><p>原提醒：{timeLabel(item.match.reminderAt)}<br/>新提醒：{item.task.reminderMode === 'none' ? '不提醒' : timeLabel(fromChinaInput(item.task.reminderMode === 'default' ? item.due : item.reminder))}</p><span className="field-hint">只更新日期与提醒；保留原名称、备注及完成状态。{item.match.completed ? '已完成的任务不会重新提醒。' : ''}</span></> : <p>现有截止：{timeLabel(item.match.dueAt)} · 保留当前安排</p>}{item.match.evidence && <details><summary>查看关联依据</summary><blockquote>{item.match.evidence}</blockquote></details>}<button type="button" className="text-button" disabled={busy} onClick={() => update(item.id, { forceCreate: !item.forceCreate, selected: !item.forceCreate })}>{item.forceCreate ? '撤销另建，保留关联判断' : '这是另一件事，另建提醒'}</button></div>}
          <label>任务名称<input aria-label={`第${index + 1}条任务名称`} maxLength={500} value={item.match?.kind === 'update' && !item.forceCreate ? item.match.title : item.task.title} disabled={busy || (!!item.match && !item.forceCreate)} onChange={event => updateTask(item, { title: event.target.value })}/></label>
          {item.assessment && <div className={`campus-assessment assessment-${item.assessment.status}`}><strong>{assessmentLabels[item.assessment.status]}</strong><p>{item.assessment.reason}</p>{item.assessment.audienceEvidence && <p className="field-hint">通知对象原文：{item.assessment.audienceEvidence}</p>}{item.assessment.questions.length > 0 && <><span>请在上方“本次补充”回答：</span><ul>{item.assessment.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></>}</div>}
          {item.warnings.length > 0 && <div className="import-warnings">{item.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div>}
          <p className="import-time-summary">截止：{timeLabel(fromChinaInput(item.due))} · {item.task.reminderMode === 'none' ? '不提醒' : item.task.reminderMode === 'default' ? '到点提醒' : `首次 ${timeLabel(fromChinaInput(item.reminder))} 提醒`}</p>
          <details className="import-edit" open={!item.due || undefined}><summary>调整时间和分类</summary>
          <label>截止时间<input aria-label={`第${index + 1}条截止时间`} type="datetime-local" value={item.due} disabled={busy} onChange={event => update(item.id, { due: event.target.value, task: { ...item.task, reminderTimes: undefined } })}/></label>
          <div className="field-row"><label>提醒方式<select value={item.task.reminderMode} disabled={busy || !item.due} onChange={event => updateTask(item, { reminderMode: event.target.value as TaskInput['reminderMode'], reminderTimes: undefined })}><option value="default">到点提醒</option><option value="custom">指定时间</option><option value="none">不提醒</option></select></label>{(!item.match || item.forceCreate) && <label>分类<select value={item.task.category} disabled={busy} onChange={event => updateTask(item, { category: event.target.value as Task['category'] })}>{CATEGORIES.map(category => <option key={category}>{category}</option>)}</select></label>}</div>
          {item.due && item.task.reminderMode === 'custom' && <label>首次提醒<input aria-label={`第${index + 1}条提醒时间`} type="datetime-local" value={item.reminder} disabled={busy} onChange={event => update(item.id, { reminder: event.target.value, task: { ...item.task, reminderTimes: undefined } })}/>{!!item.task.reminderTimes?.length && <span className="field-hint">另有 {item.task.reminderTimes.length} 次后续提醒，修改时间将改为单次提醒。</span>}</label>}
          {!item.due && <p className="field-hint">未填日期时保留待办，不安排提醒。</p>}
          </details>
          <details><summary>来源摘录与备注</summary><blockquote>{item.evidence || '手动创建'}</blockquote>{item.match && !item.forceCreate ? <p className="field-hint">已有任务的个人备注会保留。</p> : <label>备注<textarea rows={3} value={item.task.notes || ''} disabled={busy} maxLength={4000} onChange={event => updateTask(item, { notes: event.target.value })}/></label>}</details>
        </article>)}
      </>}
      <p className="form-message error" role="alert">{error}</p>
      <div className="modal-actions import-actions"><button className="secondary" disabled={phase === 'save'} onClick={close}>{busy ? '取消' : '关闭'}</button><button className="primary" disabled={busy || !selected.length} onClick={() => void save()}>{updates ? `确认更新 ${updates} 条${selected.length > updates ? `，新增 ${selected.length - updates} 条` : ''}` : `加入 ${selected.length} 条待办`}</button></div>
    </section>
  </div>;
}
