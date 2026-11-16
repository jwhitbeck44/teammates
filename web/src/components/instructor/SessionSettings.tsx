import { useState } from 'react';
import { updateSession } from '../../api/instructor';
import { validateSessionSettings, GRACE_OPTIONS } from '../../lib/validation';
import { formatInstant } from '../../lib/time';
import type { ResultsVisibility, Session } from '../../lib/types';
import { LocalDateTime } from './LocalDateTime';
import { ErrorBox, useAction } from './ui';

export default function SessionSettings({ session, timeZone, onSaved }: { session: Session; timeZone: string; onSaved: () => void }) {
  const [name, setName] = useState(session.name);
  const [instructions, setInstructions] = useState(session.instructions);
  const [opens, setOpens] = useState<string | null>(session.opens_at);
  const [closes, setCloses] = useState<string | null>(session.closes_at);
  const [grace, setGrace] = useState(session.grace_minutes);
  const [visibility, setVisibility] = useState<ResultsVisibility>(session.results_visibility);
  const [visibleAt, setVisibleAt] = useState<string | null>(session.results_visible_at);
  const [closingEmail, setClosingEmail] = useState(session.closing_email_enabled);
  const [publishedEmail, setPublishedEmail] = useState(session.published_email_enabled);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const action = useAction();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (!opens || !closes) {
      setProblems(['Enter the open and close date and time.']);
      return;
    }
    const input = {
      name: name.trim(),
      instructions,
      opens_at: opens,
      closes_at: closes,
      grace_minutes: grace,
      results_visibility: visibility,
      results_visible_at: visibility === 'custom' ? visibleAt : null,
      closing_email_enabled: closingEmail,
      published_email_enabled: publishedEmail,
    };
    const errs = validateSessionSettings(input);
    if (errs.length > 0) {
      setProblems(errs.map((x) => (x.field ? `${x.field}: ${x.message}` : x.message)));
      return;
    }
    setProblems([]);
    if (await action.run(() => updateSession(session.id, input))) {
      setSaved(true);
      onSaved();
    }
  }

  return (
    <form className="ins-form" onSubmit={save}>
      <label>
        Session name
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
      </label>
      <label>
        Instructions for students
        <textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </label>
      <div className="ins-row">
        <div>
          <div><strong>Opens</strong></div>
          <LocalDateTime value={session.opens_at} timeZone={timeZone} onChange={setOpens} label="" />
        </div>
        <div>
          <div><strong>Closes</strong></div>
          <LocalDateTime value={session.closes_at} timeZone={timeZone} onChange={setCloses} label="" />
        </div>
        <label>
          Grace period
          <select value={grace} onChange={(e) => setGrace(Number(e.target.value))}>
            {GRACE_OPTIONS.map((g) => <option key={g} value={g}>{g} minutes</option>)}
          </select>
        </label>
      </div>
      <p className="ins-hint">
        Times are in the course time zone ({timeZone}). Students can see the session from its open time. They can submit
        until the close time plus the grace period.
      </p>

      <fieldset>
        <legend><strong>When students can see results</strong></legend>
        <label className="ins-inline">
          <input type="radio" name="vis" checked={visibility === 'later'} onChange={() => setVisibility('later')} /> When I publish them
        </label>
        <label className="ins-inline">
          <input type="radio" name="vis" checked={visibility === 'at_open'} onChange={() => setVisibility('at_open')} /> As soon as the session opens
        </label>
        <label className="ins-inline">
          <input type="radio" name="vis" checked={visibility === 'custom'} onChange={() => setVisibility('custom')} /> At a set time
        </label>
        {visibility === 'custom' && (
          <div>
            <LocalDateTime value={session.results_visible_at} timeZone={timeZone} onChange={setVisibleAt} label="" />
          </div>
        )}
        {session.published_at && (
          <p className="ins-hint">Published by hand on {formatInstant(session.published_at, timeZone, { zoneName: true })}. Unpublish from the status page.</p>
        )}
      </fieldset>

      <fieldset>
        <legend><strong>Emails</strong></legend>
        <label className="ins-inline"><input type="checkbox" checked disabled /> Session opened (always sent)</label>
        <label className="ins-inline"><input type="checkbox" checked={closingEmail} onChange={(e) => setClosingEmail(e.target.checked)} /> Closing soon (24 hours before)</label>
        <label className="ins-inline"><input type="checkbox" checked={publishedEmail} onChange={(e) => setPublishedEmail(e.target.checked)} /> Results published</label>
      </fieldset>

      {problems.length > 0 && <div className="ins-error" role="alert"><ul>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
      <ErrorBox error={action.error} />
      {saved && <p className="ins-ok">Saved.</p>}
      <button type="submit" className="ins-primary" disabled={action.busy}>Save settings</button>
    </form>
  );
}
