import { outreachMix } from '../../mix.js';

const SOURCES = [['linkedin', 'LinkedIn'], ['indeed', 'Indeed'], ['glassdoor', 'Glassdoor'], ['web', 'Open web'], ['x', 'X'], ['ycombinator', 'Y Combinator'], ['wellfound', 'Wellfound']];
const ACTIONS = [['email', 'Email'], ['posts', 'LinkedIn posts'], ['connect', 'Connect note'], ['dm', 'Direct message'], ['easy_apply', 'Easy Apply'], ['form', 'Company form']];

function rows(group, pairs, values) {
  return pairs.map(([k, label]) => `<label class="mixrow"><span>${label}</span><input type="range" min="0" max="100" value="${values[k]}" data-mix="${group}" data-key="${k}" oninput="mixMove(this)"><b>${values[k]}</b></label>`).join('');
}

export function renderMix(preferences = {}) {
  const mix = outreachMix(preferences);
  const keepOn = preferences?.keepRemoteOrVisa !== false;
  const adaptOn = preferences?.adaptFields === true;
  return `<section class="mix"><div class="mixbox"><h2>Where to look</h2>${rows('sources', SOURCES, mix.sources)}</div><div class="mixbox"><h2>What to do</h2>${rows('actions', ACTIONS, mix.actions)}</div><div class="mixbox keepbox"><h2>Which leads to keep</h2><label class="keeprow"><input type="checkbox" id="keep-remote" ${keepOn ? 'checked' : ''} onchange="document.querySelector('meta[http-equiv=refresh]')?.remove()"><span>Remote with no country list, or visa and relocation in a place you listed</span></label><p class="dim">A timezone overlap stays. Onsite and hybrid need a visa or relocation offer in a listed place. "No sponsorship" is not an offer. Among the keepers, email the named founder, hiring lead, or the address printed on the post.</p></div><div class="mixbox keepbox"><h2>Adapt missing address fields</h2><label class="keeprow"><input type="checkbox" id="adapt-fields" ${adaptOn ? 'checked' : ''} onchange="document.querySelector('meta[http-equiv=refresh]')?.remove()"><span>Fill a postal code or province from your city when the profile has none</span></label><p class="dim">Karachi becomes 75500 and Sindh. Lahore becomes 54000 and Punjab. Salary, visa, and a street address stay as written on the profile.</p></div><p class="dim">Each group stays at 100. Y Combinator and Wellfound stay at 0 until you give them a share. Save stores the mix and these switches on your profile. The next cycle follows it, including X, LinkedIn posts, connect notes, direct messages, and email.</p><button id="mix-save" onclick="saveMix()">Save mix</button></section>
<script>
function mixMove(el){
  document.querySelector('meta[http-equiv="refresh"]')?.remove();
  const others=[...document.querySelectorAll('input[data-mix="'+el.dataset.mix+'"]')].filter(i=>i!==el);
  let rest=Math.max(0,100-Number(el.value)), prev=others.reduce((s,i)=>s+Number(i.value),0)||others.length;
  others.forEach((i,idx)=>{ const n=idx===others.length-1?rest:Math.max(0,Math.min(rest,Math.round(Number(i.value)/prev*rest))); i.value=n; rest-=n; i.parentElement.querySelector('b').textContent=i.value; });
  el.parentElement.querySelector('b').textContent=el.value;
}
async function saveMix(){
  const read=g=>{const o={}; document.querySelectorAll('input[data-mix="'+g+'"]').forEach(i=>o[i.dataset.key]=Number(i.value)); return o;};
  const btn=document.getElementById('mix-save'); btn.disabled=true;
  const keep=document.getElementById('keep-remote')?.checked!==false;
  const adapt=document.getElementById('adapt-fields')?.checked===true;
  try {
    const r=await fetch(apiBase()+'/api/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({preferences:{mix:{sources:read('sources'),actions:read('actions')},keepRemoteOrVisa:keep,adaptFields:adapt}})});
    if(!r.ok) throw new Error('HTTP '+r.status);
    location.reload();
  } catch(e) { btn.disabled=false; alert('Could not save the mix. Open the dashboard from its server URL.\\n\\n'+e.message); }
}
</script>`;
}
