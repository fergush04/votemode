import * as shp from 'shapefile';
import * as ts from 'topojson-server';
import * as tsimp from 'topojson-simplify';
import fs from 'fs';
const SITE='/sessions/optimistic-inspiring-faraday/mnt/Website';
const SKIP=new Set(['02','11']); // AK districts + DC wards keep custom topos
const FIPS2AB={'01':'al','04':'az','05':'ar','06':'ca','08':'co','09':'ct','10':'de','12':'fl','13':'ga','15':'hi','16':'id','17':'il','18':'in','19':'ia','20':'ks','21':'ky','22':'la','23':'me','24':'md','25':'ma','26':'mi','27':'mn','28':'ms','29':'mo','30':'mt','31':'ne','32':'nv','33':'nh','34':'nj','35':'nm','36':'ny','37':'nc','38':'nd','39':'oh','40':'ok','41':'or','42':'pa','44':'ri','45':'sc','46':'sd','47':'tn','48':'tx','49':'ut','50':'vt','51':'va','53':'wa','54':'wv','55':'wi','56':'wy'};
// Only county-reporting states get rebuilt topos (NE town states keep their town topos)
const TOWN_STATES=new Set(['ct','me','ma','nh','ri','vt']);

const byState={};
const source=await shp.open('/tmp/geo/cb_2023_us_county_500k/cb_2023_us_county_500k.shp');
while(true){
  const r=await source.read();
  if(r.done) break;
  const p=r.value.properties;
  const ab=FIPS2AB[p.STATEFP];
  if(!ab || SKIP.has(p.STATEFP) || TOWN_STATES.has(ab)) continue;
  (byState[ab]??=[]).push({type:'Feature', id:p.GEOID,
    properties:{name:p.NAME}, geometry:r.value.geometry});
}
let total=0;
for(const [ab,features] of Object.entries(byState)){
  let topo=ts.topology({counties:{type:'FeatureCollection',features}},1e5);
  // light simplification to keep files lean while preserving 500k character
  topo=tsimp.presimplify(topo);
  const min=tsimp.quantile(topo,0.4);   // drop the least-significant 40% of points
  topo=tsimp.simplify(topo,min);
  const out=`${SITE}/data/geo/${ab}_counties.json`;
  fs.writeFileSync(out,JSON.stringify(topo));
  const kb=(fs.statSync(out).size/1024).toFixed(0);
  total++;
  console.log(ab, features.length, 'counties', kb+'KB');
}
console.log('states written:',total);
