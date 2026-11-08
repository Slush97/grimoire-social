// Offline adapter exercising the same aggregation functions intended for both UIs.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { aggregatePersonalBenchmarks, aggregateCommunityBenchmarks } from '../../packages/social-types/src/benchmarks';

const [input, output, owner = 'local-pilot'] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: tsx cli/benchmark/preview.ts records.json output-directory [owner]');
const records: unknown = JSON.parse(readFileSync(input, 'utf8'));
if (!Array.isArray(records)) throw new Error('Expected an array of internal benchmark records');
const personal = aggregatePersonalBenchmarks(records, owner);
const community = aggregateCommunityBenchmarks(records);
const destination = resolve(output);
mkdirSync(destination, { recursive: true });
for (const [name, value] of Object.entries({ personal, community })) {
  writeFileSync(join(destination, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
const data = JSON.stringify({ personal, community }).replace(/</g, '\\u003c');
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Grimoire benchmark aggregation preview</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#10121b;color:#e9eaf2;font:16px/1.55 system-ui,sans-serif}
main{max-width:1120px;margin:auto;padding:48px 24px}h1{font-size:clamp(28px,5vw,44px);line-height:1.15;margin:10px 0 16px}
h2{font-size:21px;margin:0 0 14px}p{max-width:85ch;color:#b9bfd0}.eyebrow{color:#bca8ff;font-size:13px;letter-spacing:.12em;text-transform:uppercase}
.notice,.panel{border:1px solid #34394e;border-radius:12px;padding:22px;background:#191d2a;margin:20px 0}
.notice{border-color:#877040;background:#29251e;color:#e8d4a6}label{display:inline-flex;flex-direction:column;gap:6px;margin:0 20px 10px 0}
select{font:inherit;color:inherit;background:#252b3c;border:1px solid #636c85;border-radius:6px;padding:8px 12px}
.row{display:grid;grid-template-columns:minmax(160px,250px) 1fr 100px;gap:14px;align-items:center;margin:22px 0}
.track{background:#30374d;border-radius:5px;height:26px;overflow:hidden}.bar{height:100%;background:#b09bfa}.value{text-align:right;font-variant-numeric:tabular-nums}
.muted{color:#aab2c6;font-size:14px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:12px;border-bottom:1px solid #34394e;vertical-align:top}
.scroll{overflow:auto}summary{cursor:pointer;color:#c8b9ff}dl{display:grid;grid-template-columns:180px 1fr;gap:6px;font-size:14px}dt{color:#aab2c6}dd{margin:0;overflow-wrap:anywhere}
a{color:#c8b9ff}button:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible{outline:3px solid #d1c4ff;outline-offset:3px}
@media(max-width:600px){main{padding:24px 14px}.row{grid-template-columns:130px 1fr 65px;gap:8px;font-size:13px}dl{grid-template-columns:1fr}dd{margin-bottom:8px}}
</style></head><body><main>
<span class="eyebrow">Grimoire / local prototype</span><h1>Benchmark results, with context.</h1>
<p>A working preview of the shared aggregation model for the app and grimoire-site. Personal measurements stay separate from publishable community statistics.</p>
<div class="notice">Exploratory data from one machine. Fight timing and effective settings remain unverified. These results do not establish a community ranking.</div>
<label>View<select id="view"><option value="personal">Personal history</option><option value="community">Community aggregates</option></select></label>
<label>Metric<select id="metric"><option value="average_fps">Average FPS</option><option value="one_percent_low_fps">1% low FPS</option><option value="p99_frame_time_ms">p99 frame time</option><option value="hitches_over_50ms_per_minute">Frames over 50 ms / minute</option></select></label>
<section class="panel" aria-live="polite"><h2 id="heading"></h2><p id="explanation"></p><div id="chart"></div></section>
<section class="panel"><h2>Attempts and evidence</h2><div class="scroll"><table><thead><tr><th>Preset</th><th>Completed / attempted</th><th>Failed / cancelled</th><th>Contributors / machines</th><th>Assessment</th></tr></thead><tbody id="rows"></tbody></table></div><div id="details"></div></section>
<p class="muted">This page makes no network requests. JSON files contain aggregate summaries; raw logs, paths, configuration files and individual identities are excluded.</p>
<p><a href="personal.json">Personal summary JSON</a> · <a href="community.json">Community summary JSON</a></p>
</main><script type="application/json" id="data">${data}</script><script>
const data = JSON.parse(document.getElementById('data').textContent);
const view = document.getElementById('view'), metric = document.getElementById('metric');
function element(tag, text, className) { const e = document.createElement(tag); if(text !== undefined)e.textContent=text; if(className)e.className=className; return e; }
function render() {
 const community = view.value === 'community', result = data[view.value];
 const cohorts = [...result.cohorts].sort((a,b) => a.context.preset_id.localeCompare(b.context.preset_id));
 document.getElementById('heading').textContent = community ? 'Community results' : 'Your preset comparisons';
 document.getElementById('explanation').textContent = community
  ? 'Only accepted, aligned measurements qualify. Each group needs at least 5 contributors and 10 completed launches. Empty groups disclose no hardware or counts.'
  : 'Median per launch, with observed launch range. Loading and warm-up are excluded from these estimated fight windows. Presets differ in visual quality.';
 const chart=document.getElementById('chart'), rows=document.getElementById('rows'), details=document.getElementById('details');
 chart.replaceChildren(); rows.replaceChildren(); details.replaceChildren();
 if(!cohorts.length) {chart.append(element('p','No publishable community groups yet. Your local results remain available in Personal history.')); return;}
 const max=Math.max(1,...cohorts.map(c=>c.metrics?.[metric.value]?.median??0));
 for(const c of cohorts) {
  const m=c.metrics?.[metric.value], name=c.context.preset_id+' · '+c.context.preset_version;
  const row=element('div',undefined,'row'); row.append(element('div',name));
  const track=element('div',undefined,'track'), bar=element('div',undefined,'bar'); bar.style.width=((m?.median??0)/max*100)+'%'; track.append(bar); row.append(track,element('div',m?m.median.toFixed(1):'No data','value')); chart.append(row);
  if(m)chart.append(element('p','Observed range '+m.min.toFixed(1)+' to '+m.max.toFixed(1)+'; distribution unit: '+c.distribution_unit+'.','muted'));
  const tr=element('tr'); for(const value of [name,c.completed_launches+' / '+c.attempts,c.failed_attempts+' / '+c.cancelled_attempts,c.contributors+' / '+c.machines,c.assessment])tr.append(element('td',value)); rows.append(tr);
  const d=element('details'), s=element('summary',name+' hardware, OS and configuration'), dl=element('dl');
  const ctx=c.context;
  const fields={'CPU':ctx.cpu,'GPU':ctx.gpu,'RAM bucket':ctx.ram_bucket_gib+' GiB (OS usable memory bucket)',
   'OS / kernel':ctx.os+' / '+ctx.os_version,'Driver':ctx.driver??'Unknown','Graphics API':ctx.graphics_api??'Unverified',
   'Compatibility layer':ctx.compatibility_layer??'None','Runtime':ctx.runtime,'Game build':ctx.game_build,
   'Display':ctx.width+' × '+ctx.height+' / '+ctx.render_scale*100+'% scale','Frame cap':ctx.frame_cap||'Uncapped',
   'VSync':ctx.vsync?'On':'Off','Power policy':ctx.power_policy??'Unknown','Capture':ctx.capture_backend+' '+ctx.capture_version,
   'Launch policy':ctx.launch_policy_sha256??'Complete effective launch options not recorded',
   'Effective settings':ctx.effective_settings_verified?'Verified':'Unverified','Settings SHA-256':ctx.settings_sha256,
   'Scope':ctx.scope,'Recorded UTC':c.first_recorded_day+' to '+c.last_recorded_day,'Caveats':c.reasons.join(', ')};
  for(const [key,value] of Object.entries(fields))dl.append(element('dt',key),element('dd',String(value)));
  d.append(s,dl);details.append(d);
 }
}
view.addEventListener('change',render);metric.addEventListener('change',render);render();
</script></body></html>`;
writeFileSync(join(destination, 'index.html'), html, { flag: 'wx' });
console.log(JSON.stringify({ output: destination, personal_cohorts: personal.cohorts.length,
  community_cohorts: community.cohorts.length }));
