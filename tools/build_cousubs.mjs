import * as shp from 'shapefile';
import * as ts from 'topojson-server';
import fs from 'fs';
const SITE='/sessions/optimistic-inspiring-faraday/mnt/Website';
const WANT={'09':'ct','25':'ma','33':'nh','44':'ri','50':'vt'};
const slug=s=>s.trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
// canonical form for fuzzy matching: expand direction abbrevs, drop unit-type words,
// strip possessive s / trailing s per word
const DIR={n:'north',s:'south',e:'east',w:'west'};
const TYPE=new Set(['town','city','township','plantation','plt']);
const canon=id=>id.split('_')
  .map((w,i)=> i===0 ? (DIR[w]||w) : w)   // direction abbrevs only lead (s_burlington), medial 's' is possessive
  .filter(w=>!TYPE.has(w) && w!=='s')
  .map(w=>w.replace(/s$/,''))
  .join('');

const byState={};
const src=await shp.open('/tmp/geo/cb_2023_us_cousub_500k/cb_2023_us_cousub_500k.shp');
while(true){
  const r=await src.read(); if(r.done)break;
  const p=r.value.properties;
  const ab=WANT[p.STATEFP]; if(!ab) continue;
  if(p.COUSUBFP==='00000'||/not defined/i.test(p.NAMELSAD)) continue;
  (byState[ab]??=[]).push({name:p.NAME,namelsad:p.NAMELSAD,geometry:r.value.geometry});
}
for(const [ab,rows] of Object.entries(byState)){
  const data=JSON.parse(fs.readFileSync(`${SITE}/data/states/${ab}.json`));
  const dataIds=new Set(Object.keys(data.units));
  const counts={};
  rows.forEach(r=>{const s=slug(r.name);counts[s]=(counts[s]||0)+1;});
  let feats=rows.map(r=>({type:'Feature',
    id: counts[slug(r.name)]>1 ? slug(r.namelsad) : slug(r.name),
    properties:{name:r.name.toUpperCase()}, geometry:r.geometry, _lsad:slug(r.namelsad)}));
  // pass 2: canonical matching for leftovers
  const gset=new Set(feats.map(f=>f.id));
  const unData=[...dataIds].filter(i=>!gset.has(i)&&!['federal','state_uocava'].includes(i));
  const unGeo=feats.filter(f=>!dataIds.has(f.id));
  const byCanon={};
  unData.forEach(i=>{(byCanon[canon(i)]??=[]).push(i);});
  let renamed=0;
  for(const f of unGeo){
    const c=byCanon[canon(f.id)] || byCanon[canon(f._lsad)];
    if(c && c.length===1){ f.id=c[0]; renamed++; }
  }
  const gset2=new Set(feats.map(f=>f.id));
  if(gset2.size!==feats.length) throw new Error(ab+': duplicate ids after rename');
  const stillUnData=[...dataIds].filter(i=>!gset2.has(i)&&!['federal','state_uocava'].includes(i));
  const stillUnGeo=feats.filter(f=>!dataIds.has(f.id)).map(f=>f.id);
  console.log(ab.toUpperCase(),feats.length,'feats | renamed:',renamed,'| data w/o geo:',stillUnData.length?stillUnData:'-','| grey extras:',stillUnGeo.length?stillUnGeo:'-');
  if(stillUnData.length) { console.log(ab,'NOT WRITTEN'); continue; }
  feats.forEach(f=>delete f._lsad);
  const topo=ts.topology({towns:{type:'FeatureCollection',features:feats}},1e5);
  const NE_DIR={ct:'ct',ma:'ma',nh:'nh',ri:'ri',vt:'vt'};
  const out=`${SITE}/data/geo/new_england/${NE_DIR[ab]}_towns_topo.json`;
  fs.writeFileSync(out,JSON.stringify(topo));
  console.log('  wrote',out.split('/').pop(),(fs.statSync(out).size/1024).toFixed(0)+'KB');
}
