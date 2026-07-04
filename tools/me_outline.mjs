import * as shp from 'shapefile';
import * as ts from 'topojson-server';
import fs from 'fs';
const source=await shp.open('/tmp/geo/cb_2023_us_state_500k/cb_2023_us_state_500k.shp');
let me=null;
while(true){ const r=await source.read(); if(r.done)break;
  if(r.value.properties.STUSPS==='ME') me=r.value; }
if(!me) throw new Error('ME not found');
const topo=ts.topology({outline:{type:'FeatureCollection',features:[{type:'Feature',id:'me',properties:{name:'Maine'},geometry:me.geometry}]}},1e5);
fs.writeFileSync('/sessions/optimistic-inspiring-faraday/mnt/Website/data/geo/new_england/me_outline_topo.json',JSON.stringify(topo));
console.log('me outline KB:',(fs.statSync('/sessions/optimistic-inspiring-faraday/mnt/Website/data/geo/new_england/me_outline_topo.json').size/1024).toFixed(0));
