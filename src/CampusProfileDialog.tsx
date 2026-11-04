import { useRef, useState, type FormEvent } from 'react';
import { CAMPUS_INTERESTS, STUDY_STAGES, normalizeCampusProfile, type CampusProfile } from '../electron/campus-profile';

export default function CampusProfileDialog({ profile, required, onSave, onClose }: {
  profile?: CampusProfile; required: boolean; onSave: (profile: CampusProfile) => Promise<void>; onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const [school, setSchool] = useState(profile?.school || '');
  const [major, setMajor] = useState(profile?.major || '');
  const [stage, setStage] = useState(profile?.stage || '');
  const [roles, setRoles] = useState(profile?.roles || '');
  const [interests, setInterests] = useState<string[]>(profile?.interests || []);
  const [dateOnlyMode, setDateOnlyMode] = useState<CampusProfile['dateOnlyMode']>(profile?.dateOnlyMode || 'hourly');
  const [dailyTime, setDailyTime] = useState(profile?.dailyTime || '19:00');
  const [shareWithAI, setShareWithAI] = useState(profile?.shareWithAI || false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const section = useRef<HTMLElement>(null);
  function changeStep(next: number) { setStep(next); setError(''); section.current?.scrollTo(0, 0); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    if (!stage) { setError('请选择学习阶段，也可以选择“暂不填写”。'); return; }
    if (step === 0) { changeStep(1); return; }
    setBusy(true); setError('');
    try { await onSave(normalizeCampusProfile({ version: 1, school, major, stage, roles, interests, dateOnlyMode, dailyTime, shareWithAI })); }
    catch (error) { setError(error instanceof Error ? error.message : '保存失败，请重试'); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop campus-backdrop" onKeyDown={event => { if (event.key === 'Escape' && !required && !busy) onClose(); }}>
    <section ref={section} className="modal campus-modal" role="dialog" aria-modal="true" aria-label="校园资料">
      <header className="modal-head"><div><span className="campus-kicker">校园助手 · {step + 1} / 2</span><h2>{step === 0 ? '先认识一下你' : '按你的节奏提醒'}</h2><p>{step === 0 ? '用几项资料，帮你判断哪些校园通知需要行动。' : '关注事项帮助理解通知；提醒偏好只影响没有具体时刻的任务。'}</p></div>{!required && <button className="icon-button" aria-label="关闭校园资料" onClick={onClose} disabled={busy}>×</button>}</header>
      <form onSubmit={event => void submit(event)}>
        {step === 0 ? <>
          <label>学习阶段<select autoFocus aria-label="学习阶段" value={stage} onChange={event => setStage(event.target.value)} required><option value="" disabled>请选择</option>{STUDY_STAGES.map(item => <option key={item}>{item}</option>)}</select></label>
          <label>学校 <span className="optional">选填</span><input aria-label="学校" maxLength={100} value={school} onChange={event => setSchool(event.target.value)} placeholder="用于判断通知面向的学校"/></label>
          <label>专业 / 学院 <span className="optional">选填</span><input aria-label="专业或学院" maxLength={100} value={major} onChange={event => setMajor(event.target.value)} placeholder="例如：计算机学院 · 软件工程"/></label>
          <label>其他校园身份 <span className="optional">选填</span><textarea aria-label="校园身份" rows={2} maxLength={300} value={roles} onChange={event => setRoles(event.target.value)} placeholder="例如：班委、社团成员；不确定可留空"/></label>
          <p className="field-hint">不用填写姓名、学号或联系方式。未填的信息会视为未知，需要时再问你；资料可在设置中修改。</p>
        </> : <>
          <fieldset className="campus-interests"><legend>关注哪些事项？<span className="optional">可多选</span></legend><div>{CAMPUS_INTERESTS.map(item => <button key={item} type="button" aria-pressed={interests.includes(item)} className={interests.includes(item) ? 'selected' : ''} onClick={() => setInterests(current => current.includes(item) ? current.filter(value => value !== item) : [...current, item])}>{item}</button>)}</div></fieldset>
          <label>只有日期、没有具体时刻时<select aria-label="模糊日期提醒方式" value={dateOnlyMode} onChange={event => setDateOnlyMode(event.target.value as CampusProfile['dateOnlyMode'])}><option value="hourly">当天每小时，之前每天一次</option><option value="daily">每天在我选定的时间提醒</option></select></label>
          {dateOnlyMode === 'daily' && <label>每日提醒时间（北京时间）<input aria-label="每日提醒时间" type="time" required value={dailyTime} onChange={event => setDailyTime(event.target.value)}/><span className="field-hint">今天到期且所选时间已过，会在 5 分钟内提醒。</span></label>}
          <p className="field-hint">“今天 21 点提醒”始终在 21 点提醒，不会自动提前一小时。此偏好只用于新建任务；提醒未回复仍在 5 分钟后重试。</p>
          <label className="checkbox-label campus-consent"><input type="checkbox" aria-label="允许AI使用校园资料" checked={shareWithAI} onChange={event => setShareWithAI(event.target.checked)}/>允许 AI 使用校园资料判断通知相关性</label>
          <p className="field-hint">资料保存在本机。开启后，使用 AI 整理时会把学校、专业、学习阶段、身份及关注事项一起发送给 DeepSeek。关闭后不发送这些资料，日期提醒偏好仍在本地生效。</p>
        </>}
        <p className="form-message error" role="alert">{error}</p>
        <div className="modal-actions campus-actions">{step === 1 ? <button type="button" className="secondary" disabled={busy} onClick={() => changeStep(0)}>上一步</button> : <span className="field-hint">约半分钟 · 可选择暂不填写</span>}<button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : step === 0 ? '下一步' : required ? '保存并继续' : '保存资料'}</button></div>
      </form>
    </section>
  </div>;
}
