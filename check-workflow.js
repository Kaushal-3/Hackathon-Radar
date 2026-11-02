// Offline check: runs the real Code-node source from the workflow with mocked APIs.
// It covers the workflow's logic, not live Tavily/Gemini behaviour or the n8n runtime.
// Usage: node check-workflow.js ["path/to/workflow.json"]
const fs = require('fs');
const assert = require('assert');
const wf = JSON.parse(fs.readFileSync(process.argv[2] || 'Hackathon Radar.json', 'utf8'));
const code = Object.fromEntries(wf.nodes.filter(n => n.parameters.jsCode).map(n => [n.name, n.parameters.jsCode]));
const settings = JSON.parse(wf.nodes.find(n => n.name.startsWith('Settings')).parameters.jsonOutput);
const clone = x => JSON.parse(JSON.stringify(x));

const eventPage = i => `# Build with AI Hackathon ${i} 2026\n\nBuild with AI Hackathon ${i} 2026 is organized by Acme Labs. Participants must build an AI application that solves a public problem. ` +
  'This hackathon is online. Open to everyone including professionals and students. Participants from India are eligible. Registration closes on 2099-12-20. Prize pool of Rs 5,00,000. '.repeat(2) +
  `[Official site](https://acme-${i}.org/hackathon)`;
const modelEvent = (id, url, n) => ({ page_id: id, is_event: true, name: `Build with AI Hackathon ${n} 2026`, organizer: 'Acme Labs', edition: '2026',
  identity_evidence: `Build with AI Hackathon ${n} 2026 is organized by Acme Labs`, is_build_challenge: true, topic: 'ai',
  deliverable: 'An AI application', deliverable_evidence: 'Participants must build an AI application', official_url: url, announcement_url: url,
  format: 'online', format_evidence: 'This hackathon is online', students_only: false, non_student_evidence: 'Open to everyone including professionals and students',
  india_eligible: true, india_eligibility_evidence: 'Participants from India are eligible', eligibility: { value: 'Everyone', evidence: 'Open to everyone including professionals and students' },
  registration_deadline: { value: '2099-12-20', evidence: 'Registration closes on 2099-12-20' }, prizes: { value: 'Rs 5,00,000', evidence: 'Prize pool of Rs 5,00,000' } });

function simulate(scenario) {
  const out = {}, searches = [], fetched = [];
  let hit = 0;
  const run = (name, input) => {
    const $input = { first: () => ({ json: clone(input) }) };
    const $ = n => { const j = () => ({ json: clone(out[n]) }); return { first: j, get item() { return j(); } }; };
    const fn = new Function('$input', '$', '$execution', '$getWorkflowStaticData', `return (function(){${code[name]}\n})()`);
    return (out[name] = fn($input, $, { id: 'check', mode: 'manual' }, () => ({}))[0].json);
  };
  const mocks = {
    search(c) {
      searches.push(c.job.body);
      if (scenario === 'noresults') return { statusCode: 200, body: { results: [] } };
      return { statusCode: 200, body: { results: [0, 1, 2].map(() => { const n = ++hit; return { url: `https://devpost-${n}.devpost.com/`, title: `Hackathon ${n} | Devpost`, raw_content: eventPage(n) }; }) } };
    },
    fetch(c) {
      fetched.push(c.job.url);
      if (c.job.feed) {
        if (scenario === 'feedfail') return { statusCode: 500, body: 'Server error' };
        const on = scenario === 'feeds';
        if (c.job.url.includes('devpost.com/api')) return { statusCode: 200, body: JSON.stringify({ hackathons: on ? [
          { title: 'Hackathon 901', url: 'https://devpost-901.devpost.com/', open_state: 'open', invite_only: false },
          { title: 'Hackathon 902', url: 'https://devpost-902.devpost.com/', open_state: 'open', invite_only: true }] : [] }) };
        return { statusCode: 200, body: JSON.stringify({ data: { data: on ? [
          { title: 'Build with AI Hackathon 903 2026', seo_url: 'https://unstop.com/hackathons/acme-903', region: 'online', filters: [{ type: 'eligible', name: 'All' }], details: eventPage(903), regnRequirements: {} },
          { title: 'Students 904', seo_url: 'https://unstop.com/hackathons/acme-904', region: 'online', filters: [{ type: 'eligible', name: 'Undergraduate' }], details: eventPage(904) }] : [] } }) };
      }
      const n = c.job.url.match(/(?:devpost|acme)-(\d+)/)[1];
      return { statusCode: 200, body: `<html><title>Hackathon ${n}</title><main>${eventPage(n)}</main></html>` };
    },
    extract: c => ({ statusCode: 200, body: { results: [] } }),
    gemini(c) {
      const pages = JSON.parse(c.job.body.contents[0].parts.at(-1).text);
      const events = pages.map(p => {
        if (scenario === 'notevent') return { page_id: p.page_id, is_event: false };
        const e = modelEvent(p.page_id, p.url, p.url.match(/(?:devpost|acme)-(\d+)/)[1]);
        if (scenario === 'notopic') { delete e.topic; delete e.is_build_challenge; }
        if (scenario === 'uppercase') { e.topic = 'AI'; e.format = 'Online'; }
        if (scenario === 'sparse') return { page_id: p.page_id, is_event: true, name: e.name, topic: 'ai', official_url: p.url };
        if (scenario === 'unobserved') e.official_url = 'https://not-on-the-page.org/';
        if (scenario === 'external' && p.url.includes('devpost-')) e.official_url = p.url.replace(/https:\/\/devpost-(\d+).*/, 'https://acme-$1.org/hackathon');
        return e;
      });
      return { statusCode: 200, body: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ events }) }] } }] } };
    },
  };
  const collect = { search: 'Collect search results', fetch: 'Collect page content', extract: 'Collect fallback content', gemini: 'Collect verified facts' };
  let c = run('Start live run', (out['Validate settings'] = run('Validate settings', { ...settings, origin: 'manual' })));
  while (c.action !== 'send') {
    out['Action router'] = c;
    if (c.action === 'continue') c = run('Dispatch next step', c);
    else if (collect[c.action]) c = run(collect[c.action], mocks[c.action](c));
    else throw Error('Unexpected action ' + c.action);
  }
  return { c, searches, fetched, events: Object.keys(c.state.events).length };
}

const checks = {
  'normal run reports events': () => { const r = simulate('happy'); assert(r.c.digest.new.length > 0); assert.equal(r.c.researchStatus, 'complete'); },
  'searches use documented Tavily syntax': () => {
    const { searches } = simulate('happy');
    assert.equal(searches.length, 16);
    for (const b of searches) assert(!/site:|\bOR\b/.test(b.query), b.query);
    assert(searches.some(b => b.include_domains?.[0] === 'devpost.com'));
  },
  'zero search hits is a failure, not "up to date"': () => { const r = simulate('noresults'); assert.equal(r.c.researchStatus, 'failed'); assert(r.c.warnings.some(w => /no results/.test(w))); },
  'pages with no events are called out': () => { const r = simulate('notevent'); assert.notEqual(r.c.researchStatus, 'complete'); assert(r.c.warnings.some(w => /none became an event/.test(w))); },
  'omitted topic is kept for checking': () => { const r = simulate('notopic'); assert(r.events > 0); assert(r.c.digest.checking.length > 0); },
  'uppercase topic and format are accepted': () => { assert(simulate('uppercase').c.digest.new.length > 0); },
  'open-event feeds become verified events': () => {
    const r = simulate('feeds'), urls = Object.values(r.c.state.events).map(e => e.official_url);
    assert(urls.includes('https://devpost-901.devpost.com'), 'Devpost feed event missing');
    assert(urls.includes('https://unstop.com/hackathons/acme-903'), 'Unstop feed event missing');
    assert(!urls.some(u => /902|904/.test(u)), 'invite-only or student-only feed item was used');
    assert(!r.fetched.includes('https://unstop.com/hackathons/acme-903'), 'Unstop page was fetched instead of using feed fields');
    assert(Object.values(r.c.state.events).some(e => e.official_url.includes('acme-903') && e.verified), 'Unstop event did not pass verification');
  },
  'a broken feed is reported': () => { const r = simulate('feedfail'); assert(r.c.warnings.some(w => /feed could not be read/.test(w))); assert(r.c.digest.new.length > 0); },
  'image links are not followed as events': () => {
    const fns = new Function(code['Collect page content'].replace(/const c=\$\('Action router'\)[\s\S]*$/, 'return {isEventLink,isDirectory};'))();
    assert(!fns.isEventLink('https://www.kaggle.com/competitions/116727/images/thumbnail'));
    assert(fns.isDirectory('https://hack2skill.com/hackathons-listing'));
  },
  'sidebar facts outside <article> reach Gemini': () => {
    const f = new Function(code['Collect page content'].replace(/const c=\$\('Action router'\)[\s\S]*$/, 'return readPageCore;'))();
    const c = { config: { maxPageCharacters: 12000 }, state: { sources: {}, backlog: [] }, extractQueue: [], readPages: [], pages: [], coverage: { pages: 0 } };
    f(c, { url: 'https://x-1.devpost.com' }, `<article>${'About the hackathon challenge. '.repeat(20)}</article><div>Deadline: Dec 26, 2026. Who can participate: everyone.</div>`, []);
    assert(/Deadline: Dec 26/.test(c.readPages[0].text));
  },
  'events that need checking are not hidden after 3': () => { assert.equal(simulate('sparse').c.digest.checking.length, 10); },
  'Gemini must fill every field': () => {
    const run = new Function('$input', '$', '$execution', '$getWorkflowStaticData', code['Dispatch next step'].replace(/const c=dispatch\([\s\S]*$/, 'return extractionSchema();'));
    const items = run().properties.events.items;
    for (const k of ['name', 'topic', 'is_build_challenge', 'format', 'registration_deadline', 'eligibility']) assert(items.required.includes(k), k);
  },
  'unobserved official link keeps the event': () => { assert(simulate('unobserved').events >= 48); },
  // Below 48 by design: followed organizer pages share the 80-page budget, and the run warns about what it skipped.
  'organizer link does not lose events past the follow cap': () => { const r = simulate('external'); assert(r.events >= 40, String(r.events)); assert.deepEqual(r.c.diagnostics.rejected, {}); },
};
let failed = 0;
for (const [name, fn] of Object.entries(checks)) {
  try { fn(); console.log('ok   ', name); } catch (e) { failed++; console.log('FAIL ', name, '-', e.message.split('\n')[0]); }
}
process.exit(failed ? 1 : 0);
