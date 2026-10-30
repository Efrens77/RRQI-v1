/**
 * RRQI Explorer extension
 * MIT licensed; built on the Mapillary API Demo (see README / LICENSE).
 * AI outputs are predictions, never measured RRQI scores.
 */
const el = (id) => document.getElementById(id);
const METEO = 'https://api.open-meteo.com/v1/elevation';
const CALTRANS = 'https://gisdata.dot.ca.gov/arcgis/rest/services/CHhighway/Traffic_AADT/FeatureServer/0/query';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const GRAPH = 'https://graph.mapillary.com';
const SEG_MODEL = 'Xenova/segformer-b0-finetuned-cityscapes-1024-1024';
const OBJ_MODEL = 'Xenova/yolos-tiny';
const MODEL_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.2/+esm';
const IMAGE_LIMIT = 1024;

const CLASS_COLORS = {
  road:'#e34e6a', sidewalk:'#a874fb', building:'#657caa', wall:'#aea0bb', fence:'#d8a362',
  pole:'#ffc84a', 'traffic light':'#ffe054', 'traffic sign':'#fda04f', vegetation:'#3cda79',
  terrain:'#a6bc4b', sky:'#5ea9df', person:'#ffcf65', rider:'#f4a55a', car:'#34b9ff',
  truck:'#10b5c9', bus:'#5cafff', train:'#54b5e0', motorcycle:'#f0a96e', bicycle:'#f3ce76'
};
const OTHER_COLORS = ['#9f8bef','#68aec8','#d197a4','#81bba6','#b6b66e'];
const ROAD_TYPES = new Set(['motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service']);
const ROAD_EXPOSURE = { motorway:4, motorway_link:4, trunk:4, trunk_link:4, primary:4, primary_link:4,
  secondary:3, secondary_link:3, tertiary:2, tertiary_link:2, residential:1,
  unclassified:2, service:1, living_street:1 };

const app = {
  source:'none', imageId:null, photoUrl:null, blobUrl:null, inferenceUrl:null, imgReady:false,
  inferenceSize:null, record:null, records:new Map(), generation:0, imageLoadGeneration:0,
  mode:'original', semantic:null, objects:null, pixelFractions:{},
  modulePromise:null, segmenter:null, detector:null, running:false, selectedCoordinateVersion:0,
  lookupTimer:null, lookupCache:new Map(), visionEnabled:true,
};

function status(message, isError=false){const e=el('rrqi-vision-status');e.textContent=message;e.classList.toggle('error',isError);}
function dataStatus(message, isError=false){const e=el('rrqi-data-status');e.textContent=message;e.classList.toggle('error',isError);}
function safeNum(n){return Number.isFinite(Number(n))?Number(n):null;}
function fmt(n,digits=1){return n == null || !Number.isFinite(+n)?'—':Number(n).toFixed(digits);}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function degreesToRadians(x){return x*Math.PI/180;}
function haversine(lat1,lon1,lat2,lon2){const R=6371000,a=degreesToRadians(lat2-lat1),b=degreesToRadians(lon2-lon1);
  const t=Math.sin(a/2)**2+Math.cos(degreesToRadians(lat1))*Math.cos(degreesToRadians(lat2))*Math.sin(b/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(t)));
}
function setMode(mode){
  app.mode=mode;
  document.querySelectorAll('.rrqi-mode').forEach(btn=>{
    const selected=btn.dataset.mode===mode;btn.classList.toggle('active',selected);
    btn.setAttribute('aria-pressed',String(selected));
  });
  redrawOverlays();
}
function activateTab(name){
  const button=document.querySelector(`.viewer-tab[data-tab="${name}"]`);
  if(!button)return;
  // Re-use the upstream tab behavior, which also handles viewer resizing.
  button.click();
}
function clearComputed(){
  app.semantic=null;app.objects=null;app.pixelFractions={};app.inferenceSize=null;
  if(app.inferenceUrl){URL.revokeObjectURL(app.inferenceUrl);app.inferenceUrl=null;}
  el('rrqi-class-legend').innerHTML='<p class="rrqi-muted">No segmentation results for this photo.</p>';
  el('rrqi-object-list').innerHTML='<p class="rrqi-muted">No detection results for this photo.</p>';
  redrawOverlays();
}
function releaseImage(){
  if(app.blobUrl){URL.revokeObjectURL(app.blobUrl);app.blobUrl=null;}
  const img=el('rrqi-analysis-image');img.removeAttribute('src');
  el('rrqi-image-stack').hidden=true;el('rrqi-vision-placeholder').hidden=false;
  app.imgReady=false;app.photoUrl=null;clearComputed();
}
function beginRecord(source,id){
  app.generation++;app.source=source;app.imageId=id;releaseImage();
  const key=`${source}:${id}`;
  let record=app.records.get(key);
  if(!record){record={image_id:id,source,captured_at:null,latitude:null,longitude:null,
    elevation_m:null,elevation_source:null,osm_road_type:null,osm_road_name:null,osm_speed_limit:null,
    osm_lanes:null,osm_distance_m:null,road_exposure_proxy:null,road_exposure_note:null,
    caltrans_aadt_ahead:null,caltrans_aadt_back:null,caltrans_station_distance_m:null,
    caltrans_route:null,cv_segmentation_model:null,cv_objects_model:null,
    semantic_pixel_shares:{},detected_objects:[],image_url:null};app.records.set(key,record);}
  app.record=record;renderData();el('rrqi-lat').value=record.latitude??'';el('rrqi-lon').value=record.longitude??'';
  el('rrqi-vision-placeholder').innerHTML='<div class="rrqi-blank-symbol">◉</div><strong>Loading image…</strong><p>Street-level image will appear here if its host allows browser downloads. You can always upload a local copy.</p>';
  return app.generation;
}
function toCoordinates(value){
  if(!value)return null;
  if(Array.isArray(value.coordinates)&&value.coordinates.length>=2){return {lat:safeNum(value.coordinates[1]),lon:safeNum(value.coordinates[0])};}
  if(value.lat!=null&&value.lng!=null)return {lat:safeNum(value.lat),lon:safeNum(value.lng)};
  return null;
}
function updateCoordinates(lat,lon){
  if(!app.record||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180){dataStatus('Please enter valid latitude and longitude.',true);return false;}
  app.record.latitude=lat;app.record.longitude=lon;
  app.record.elevation_m=null;app.record.elevation_source=null;app.record.road_exposure_proxy=null;
  app.record.osm_road_type=null;app.record.osm_road_name=null;app.record.osm_speed_limit=null;
  app.record.osm_lanes=null;app.record.osm_distance_m=null;app.record.caltrans_aadt_ahead=null;
  app.record.caltrans_aadt_back=null;app.record.caltrans_station_distance_m=null;app.record.caltrans_route=null;
  app.selectedCoordinateVersion++;
  el('rrqi-lat').value=lat.toFixed(6);el('rrqi-lon').value=lon.toFixed(6);
  renderData();scheduleLookups();return true;
}
async function mapillaryImageSelected(ev){
  const id=String(ev.detail?.id||'');if(!id)return;
  const generation=beginRecord('mapillary',id);
  const direct=toCoordinates(ev.detail?.originalLngLat);
  if(direct&&direct.lat!=null&&direct.lon!=null)updateCoordinates(direct.lat,direct.lon);
  status('Loading selected Mapillary photo and metadata…');
  const token=window.RRQI_getToken?.();if(!token){status('Mapillary access token unavailable.',true);return;}
  try{
    const requestedFields='id,captured_at,geometry,computed_geometry,thumb_2048_url,compass_angle';
    let response=await fetch(`${GRAPH}/${encodeURIComponent(id)}?fields=${requestedFields}&access_token=${encodeURIComponent(token)}`);
    let meta=await response.json();
    if(!response.ok){
      response=await fetch(`${GRAPH}/${encodeURIComponent(id)}?fields=id,captured_at,geometry,thumb_1024_url&access_token=${encodeURIComponent(token)}`);
      meta=await response.json();
    }
    if(generation!==app.generation)return;
    if(!response.ok||meta.error)throw Error(meta.error?.message||'Mapillary image metadata request failed');
    app.record.captured_at=meta.captured_at||null;
    const coords=toCoordinates(meta.geometry)||toCoordinates(meta.computed_geometry)||direct;
    if(coords&&coords.lat!=null&&coords.lon!=null)updateCoordinates(coords.lat,coords.lon);
    const url=meta.thumb_2048_url||meta.thumb_1024_url||null;
    app.record.image_url=`https://www.mapillary.com/app/?pKey=${encodeURIComponent(id)}`;
    if(url){
      app.photoUrl=url;
      await loadRemoteImage(url,generation);
    }else throw Error('No downloadable image URL was returned. Upload a copy of the photo for CV analysis.');
  }catch(err){
    if(generation!==app.generation)return;
    status(`Image viewer works, but this photo cannot be analyzed directly: ${err.message}. Use “Use your own photo” to analyze an image file.`,true);
    el('rrqi-vision-placeholder').innerHTML='<div class="rrqi-blank-symbol">⚠</div><strong>Image analysis unavailable</strong><p>Remote image may block cross-origin loading. Upload the photo to enable local computer vision.</p>';
  }
}
function waitForImage(img){return new Promise((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error('Image decoding failed'));});}
async function loadRemoteImage(url,generation){
  // Blob fetch is intentional: it prevents a tainted canvas and makes ML use legal CORS access.
  const response=await fetch(url,{mode:'cors'});
  if(!response.ok)throw Error(`Image download failed (${response.status})`);
  const blob=await response.blob();
  if(generation!==app.generation)return;
  if(!blob.type.startsWith('image/'))throw Error('Mapillary did not return an image file');
  await showBlob(blob,generation);
}
async function showBlob(blob,generation){
  if(generation!==app.generation)return;
  if(app.blobUrl)URL.revokeObjectURL(app.blobUrl);
  app.blobUrl=URL.createObjectURL(blob);
  const img=el('rrqi-analysis-image');
  const loaded=waitForImage(img);img.src=app.blobUrl;await loaded;
  if(generation!==app.generation)return;
  app.imgReady=true;el('rrqi-vision-placeholder').hidden=true;el('rrqi-image-stack').hidden=false;
  initializeCanvases();redrawOverlays();status('Photo ready. Select Semantic, Objects, or Both to run computer vision.');
}
async function localImageChosen(file,isSample=false){
  if(!file||!file.type.startsWith('image/')){status('Choose a JPEG, PNG or WebP photo.',true);return;}
  const generation=beginRecord(isSample?'sample':'local',isSample?'rrqi-example':`${Date.now()}-${file.name}`);
  app.record.captured_at=new Date().toISOString();app.record.image_url=null;
  status('Opening local photo…');
  try{
    await showBlob(file,generation);
    if(!isSample&&window.exifr?.gps){
      try{const gps=await window.exifr.gps(file);if(generation===app.generation&&gps&&Number.isFinite(gps.latitude)&&Number.isFinite(gps.longitude))updateCoordinates(gps.latitude,gps.longitude);}catch(e){console.warn('Photo did not contain readable EXIF GPS:',e);}
    }
    if(!app.record.latitude) dataStatus('Local photo loaded. Enter its coordinates to retrieve elevation and traffic context.');
    activateTab('vision');
  }catch(err){status(`Unable to open local image: ${err.message}`,true);}
}
function initializeCanvases(){
  const img=el('rrqi-analysis-image');
  for(const id of ['rrqi-segment-canvas','rrqi-objects-canvas']){
    const canvas=el(id);canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
  }
}
function classColor(label,index=0){return CLASS_COLORS[String(label||'').toLowerCase()]||OTHER_COLORS[index%OTHER_COLORS.length];}
function hexRgb(hex){const s=hex.replace('#','');return [parseInt(s.slice(0,2),16),parseInt(s.slice(2,4),16),parseInt(s.slice(4,6),16)];}
function redrawOverlays(){
  const seg=el('rrqi-segment-canvas'),obj=el('rrqi-objects-canvas');if(!seg||!obj)return;
  const sc=seg.getContext('2d'),oc=obj.getContext('2d');sc.clearRect(0,0,seg.width,seg.height);oc.clearRect(0,0,obj.width,obj.height);
  if(!app.imgReady)return;
  if(['semantic','both'].includes(app.mode)&&app.semantic?.length)drawSemantic(sc,seg.width,seg.height);
  if(['objects','both'].includes(app.mode)&&app.objects?.length)drawObjects(oc,obj.width,obj.height);
}
function drawSemantic(ctx,width,height){
  const masks=app.semantic;
  const first=masks.find(x=>x.mask);if(!first)return;
  const w=first.mask.width,h=first.mask.height;
  const pixels=new Uint8ClampedArray(w*h*4),shares={};
  masks.forEach(({label,mask},ci)=>{
    if(!mask||mask.width!==w||mask.height!==h)return;
    const data=mask.data||[],channels=mask.channels||Math.max(1,Math.round(data.length/(w*h)));
    const [r,g,b]=hexRgb(classColor(label,ci));let count=0;
    for(let i=0;i<w*h;i++){
      const isActive=data[i*channels]!==0;
      if(!isActive)continue;
      count++;let j=i*4;pixels[j]=r;pixels[j+1]=g;pixels[j+2]=b;pixels[j+3]=255;
    }
    shares[label]=(shares[label]||0)+count/(w*h)*100;
  });
  const maskCanvas=document.createElement('canvas');maskCanvas.width=w;maskCanvas.height=h;
  maskCanvas.getContext('2d').putImageData(new ImageData(pixels,w,h),0,0);
  ctx.save();ctx.globalAlpha=Number(el('rrqi-opacity').value)/100;ctx.imageSmoothingEnabled=false;
  ctx.drawImage(maskCanvas,0,0,width,height);ctx.restore();
  app.pixelFractions=shares;
  if(app.record){app.record.semantic_pixel_shares=Object.fromEntries(Object.entries(shares).map(([k,v])=>[k,Math.round(v*10)/10]));}
  renderLegend();
}
function drawObjects(ctx,w,h){
  const sz=app.inferenceSize||{width:w,height:h};let boxes=app.objects||[];
  const sx=w/sz.width,sy=h/sz.height;
  boxes.forEach((item,i)=>{
    const b=item.box||{},x=(b.xmin||0)*sx,y=(b.ymin||0)*sy;
    const bw=((b.xmax||0)-(b.xmin||0))*sx,bh=((b.ymax||0)-(b.ymin||0))*sy;
    const color=classColor(item.label,i),line=Math.max(3,w/500);
    ctx.save();ctx.lineWidth=line;ctx.strokeStyle=color;ctx.strokeRect(x,y,bw,bh);
    const text=`${item.label} ${Math.round(item.score*100)}%`,fs=Math.max(15,Math.min(28,w/46));
    ctx.font=`bold ${fs}px system-ui`;const tw=ctx.measureText(text).width;
    const ty=Math.max(fs+8,y),tx=Math.min(Math.max(2,x),Math.max(2,w-tw-16));
    ctx.fillStyle=color;ctx.fillRect(tx,ty-fs-8,tw+14,fs+12);
    ctx.fillStyle='#081417';ctx.fillText(text,tx+7,ty);ctx.restore();
  });
}
function renderLegend(){
  const entries=Object.entries(app.pixelFractions).filter(([,v])=>v>=.2).sort((a,b)=>b[1]-a[1]).slice(0,20);
  el('rrqi-class-legend').innerHTML=entries.length?entries.map(([k,v],i)=>`<span class="rrqi-class-chip"><span class="rrqi-chip-dot" style="background:${classColor(k,i)}"></span>${escapeHtml(k)} <b>${fmt(v,1)}%</b></span>`).join(''):'<p class="rrqi-muted">No measurable classes returned.</p>';
}
function renderObjects(){
  const items=app.objects||[];
  el('rrqi-object-list').innerHTML=items.length?items.slice(0,40).map((o)=>`<div class="rrqi-object-row"><span>${escapeHtml(o.label)}</span><b>${Math.round(o.score*100)}% confidence</b></div>`).join(''):'<p class="rrqi-muted">No objects above the selected threshold.</p>';
}
async function transformerLibrary(){
  if(!app.modulePromise){
    app.modulePromise=import(MODEL_CDN).catch(async()=>import('https://esm.sh/@huggingface/transformers@3.5.2'));
  }
  return app.modulePromise;
}
async function prepareInferencePhoto(){
  if(app.inferenceUrl&&app.inferenceSize)return app.inferenceUrl;
  const img=el('rrqi-analysis-image');if(!img.complete||!img.naturalWidth)throw Error('No image loaded');
  const scale=Math.min(1,IMAGE_LIMIT/Math.max(img.naturalWidth,img.naturalHeight));
  const w=Math.round(img.naturalWidth*scale),h=Math.round(img.naturalHeight*scale);
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
  canvas.getContext('2d').drawImage(img,0,0,w,h);
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Cannot prepare photo')), 'image/jpeg',.89));
  app.inferenceSize={width:w,height:h};app.inferenceUrl=URL.createObjectURL(blob);
  return app.inferenceUrl;
}
async function loadModel(type){
  const isSeg=type==='semantic';const field=isSeg?'segmenter':'detector';
  if(app[field])return app[field];
  const task=isSeg?'image-segmentation':'object-detection',model=isSeg?SEG_MODEL:OBJ_MODEL;
  status(`Downloading ${type} model (${model})… first run can take a while.`);
  const {pipeline}=await transformerLibrary();
  app[field]=await pipeline(task,model,{device:'wasm',dtype:'q8',progress_callback:(p)=>{
    if(p?.status==='progress'&&Number.isFinite(p.progress))status(`Loading ${type} model: ${Math.round(p.progress)}%`);
  }});
  return app[field];
}
async function analyze(requirement){
  if(app.running)return;
  if(!app.imgReady){status('Select an image or upload a photo first.',true);return;}
  if(requirement==='original')return;
  const generation=app.generation;app.running=true;el('rrqi-run-vision').disabled=true;
  try{
    const image=await prepareInferencePhoto();
    if(generation!==app.generation)return;
    if(['semantic','both'].includes(requirement)&&!app.semantic){
      const model=await loadModel('semantic');status('Running pixel-level semantic segmentation on this photo…');
      const result=await model(image);
      if(generation!==app.generation)return;
      app.semantic=Array.isArray(result)?result:[];
      if(app.record)app.record.cv_segmentation_model=SEG_MODEL;
    }
    if(['objects','both'].includes(requirement)&&!app.objects){
      const model=await loadModel('objects');status('Detecting individual objects and drawing bounding boxes…');
      const result=await model(image,{threshold:.45});
      if(generation!==app.generation)return;
      app.objects=Array.isArray(result)?result:[];
      if(app.record){app.record.cv_objects_model=OBJ_MODEL;app.record.detected_objects=app.objects.map(o=>({label:o.label,confidence:Math.round(o.score*1000)/1000,box:o.box}));}
    }
    redrawOverlays();renderObjects();
    status(`Analysis complete. ${app.semantic?.length??0} segmentation classes; ${app.objects?.length??0} object detections. These are model predictions.`);
  }catch(err){
    console.error('[RRQI] AI inference failed',err);
    status(`Computer vision failed: ${err.message||err}. Use a recent browser with WebAssembly enabled. Try Semantic alone if memory is limited.`,true);
  }finally{app.running=false;el('rrqi-run-vision').disabled=false;}
}

// --------------------- Open geographic datasets ---------------------
async function requestJson(url,timeoutMs=14000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{const r=await fetch(url,{signal:controller.signal,headers:{Accept:'application/json'}});
    if(!r.ok)throw Error(`HTTP ${r.status}`);const result=await r.json();if(result?.error===true)throw Error(result.reason||'API error');return result;
  }finally{clearTimeout(timer);}
}
function lookupKey(prefix,lat,lon){return `${prefix}:${lat.toFixed(4)}:${lon.toFixed(4)}`;}
async function cachedLookup(prefix,lat,lon,fn){const key=lookupKey(prefix,lat,lon);
  if(app.lookupCache.has(key))return app.lookupCache.get(key);
  const promise=fn().catch(e=>{app.lookupCache.delete(key);throw e;});
  app.lookupCache.set(key,promise);return promise;
}
async function getElevation(lat,lon){return cachedLookup('elev',lat,lon,async()=>{
  const url=`${METEO}?latitude=${lat.toFixed(6)}&longitude=${lon.toFixed(6)}`;
  const data=await requestJson(url,12000);const n=data.elevation?.[0];
  if(!Number.isFinite(Number(n)))throw Error('No elevation coverage');
  return {meters:Number(n),source:'Open-Meteo / Copernicus GLO-90 (90 m DEM)'};
});}
function linePointDistanceMeters(lat,lon,geometry){
  if(!Array.isArray(geometry)||geometry.length<2)return Infinity;
  const rad=Math.PI/180,lonScale=111320*Math.cos(lat*rad),latScale=111320;
  let min=Infinity;
  for(let i=1;i<geometry.length;i++){
    const a=geometry[i-1],b=geometry[i];if(!a||!b)continue;
    const x1=(a.lon-lon)*lonScale,y1=(a.lat-lat)*latScale;
    const x2=(b.lon-lon)*lonScale,y2=(b.lat-lat)*latScale;
    const dx=x2-x1,dy=y2-y1,den=dx*dx+dy*dy;
    const t=den?Math.max(0,Math.min(1,-(x1*dx+y1*dy)/den)):0;
    const d=Math.hypot(x1+t*dx,y1+t*dy);min=Math.min(min,d);
  }
  return min;
}
function exposureClass(tags,distance){
  if(distance>70)return {level:'No nearby mapped road',note:'No mapped motor road within 70 m; absence of data does not imply no vehicle exposure.'};
  let rank=ROAD_EXPOSURE[tags.highway]??2;
  const speedMatch=String(tags.maxspeed||'').match(/[\d.]+/);
  if(speedMatch){const val=Number(speedMatch[0]),mph=/mph/i.test(tags.maxspeed);const kmh=mph?val*1.609344:val;
    if(kmh>=65)rank=Math.max(rank,3);
    else if(kmh>=45)rank=Math.max(rank,2);
  }
  const lanes=parseInt(tags.lanes,10);if(Number.isFinite(lanes)&&lanes>=4)rank=Math.max(rank,3);
  const names={1:'Lower exposure proxy',2:'Moderate exposure proxy',3:'Higher exposure proxy',4:'Very high exposure proxy'};
  return {level:names[rank]||'Unknown',note:'Heuristic based on mapped highway type, posted speed, lanes, and distance. NOT a traffic count or safety score.'};
}
async function getRoadContext(lat,lon){return cachedLookup('osm',lat,lon,async()=>{
  const q=`[out:json][timeout:18];way(around:80,${lat.toFixed(6)},${lon.toFixed(6)})["highway"];out tags geom;`;
  const data=await requestJson(`${OVERPASS}?data=${encodeURIComponent(q)}`,23000);
  const matches=(data.elements||[]).filter(x=>x.type==='way'&&ROAD_TYPES.has(x.tags?.highway)&&x.geometry?.length>1)
    .map(x=>({...x,distance:linePointDistanceMeters(lat,lon,x.geometry)})).sort((a,b)=>a.distance-b.distance);
  const nearest=matches[0];if(!nearest)return {roadType:null,name:null,speed:null,lanes:null,distance:null,proxy:'No nearby mapped road',note:'OSM has no mapped motor road in the queried vicinity; this does not prove absence of traffic.'};
  const e=exposureClass(nearest.tags,nearest.distance);
  return {roadType:nearest.tags.highway,name:nearest.tags.name||null,speed:nearest.tags.maxspeed||null,
    lanes:nearest.tags.lanes||null,distance:Math.round(nearest.distance),proxy:e.level,note:e.note};
});}
function numericCount(n){if(n===null||n===undefined||n==='')return null;const v=Number(String(n).replace(/,/g,''));return Number.isFinite(v)&&v>=0?v:null;}
async function getCaltrans(lat,lon){return cachedLookup('caltrans',lat,lon,async()=>{
  // Query stations around the image; the station may represent a nearby DIFFERENT highway.
  const p=new URLSearchParams({f:'json',where:'1=1',geometry:JSON.stringify({x:lon,y:lat,spatialReference:{wkid:4326}}),
    geometryType:'esriGeometryPoint',inSR:'4326',spatialRel:'esriSpatialRelIntersects',distance:'120',
    units:'esriSRUnit_Meter',outSR:'4326',outFields:'RTE,DESCRIPTION,BACK_AADT,AHEAD_AADT',returnGeometry:'true'});
  const data=await requestJson(`${CALTRANS}?${p.toString()}`,15000);
  if(data.error)throw Error(data.error.message||'Caltrans service error');
  const candidates=(data.features||[]).map(f=>{
    const a=f.attributes||{},g=f.geometry||{},distance=haversine(lat,lon,g.y,g.x);
    return {distance,a,back:numericCount(a.BACK_AADT),ahead:numericCount(a.AHEAD_AADT)};
  }).filter(c=>Number.isFinite(c.distance)&&(c.ahead!==null||c.back!==null)).sort((a,b)=>a.distance-b.distance);
  const first=candidates[0];
  if(!first||first.distance>80)return null; // no measured count confidently nearby
  return {ahead:first.ahead,back:first.back,dist:Math.round(first.distance),route:first.a.RTE||null,description:first.a.DESCRIPTION||null};
});}
function scheduleLookups(){
  clearTimeout(app.lookupTimer);
  const record=app.record;if(!record||record.latitude===null||record.longitude===null)return;
  const gen=app.generation,version=app.selectedCoordinateVersion;
  app.lookupTimer=setTimeout(()=>runLookups(record,gen,version),500);
}
async function runLookups(record,gen,version){
  const {latitude:lat,longitude:lon}=record;
  const current=()=>gen===app.generation&&version===app.selectedCoordinateVersion&&app.record===record;
  dataStatus('Retrieving public elevation, mapped road context, and Caltrans counts…');
  const requests=[
    getElevation(lat,lon).then(out=>{
      if(!current())return;record.elevation_m=out.meters;record.elevation_source=out.source;renderData();
    }).catch(err=>{if(current()){record.elevation_source=`Unavailable (${err.message})`;renderData();}}),
    getRoadContext(lat,lon).then(out=>{
      if(!current())return;Object.assign(record,{osm_road_type:out.roadType,osm_road_name:out.name,osm_speed_limit:out.speed,osm_lanes:out.lanes,osm_distance_m:out.distance,road_exposure_proxy:out.proxy,road_exposure_note:out.note});renderData();
    }).catch(err=>{if(current()){record.road_exposure_note=`OpenStreetMap lookup unavailable (${err.message})`;renderData();}}),
    getCaltrans(lat,lon).then(out=>{
      if(!current())return;Object.assign(record,{caltrans_aadt_ahead:out?.ahead??null,caltrans_aadt_back:out?.back??null,caltrans_station_distance_m:out?.dist??null,caltrans_route:out?.route??null});renderData();
    }).catch(err=>{if(current()){record.caltrans_error=String(err.message);renderData();}}),
  ];
  await Promise.allSettled(requests);
  if(current())dataStatus('Lookups complete. Counts are only shown when a Caltrans station is nearby; road exposure is a proxy, not measured traffic.');
}
function renderData(){
  const r=app.record;if(!r)return;
  el('rrqi-coords').textContent=r.latitude!==null&&r.longitude!==null?`${fmt(r.latitude,5)}, ${fmt(r.longitude,5)}`:'—';
  el('rrqi-elevation').textContent=r.elevation_m===null?'—':`${fmt(r.elevation_m,0)} m`;
  el('rrqi-elevation-source').textContent=r.elevation_source||'90 m DEM terrain estimate (loading / unavailable)';
  el('rrqi-road-proxy').textContent=r.road_exposure_proxy||'—';
  el('rrqi-road-subtitle').textContent=[r.osm_road_name||r.osm_road_type,r.osm_speed_limit&&`Speed ${r.osm_speed_limit}`,r.osm_lanes&&`${r.osm_lanes} lanes`,r.osm_distance_m!=null&&`${r.osm_distance_m} m away`].filter(Boolean).join(' · ')||r.road_exposure_note||'Checking OpenStreetMap…';
  const counts=[r.caltrans_aadt_back,r.caltrans_aadt_ahead].filter(x=>x!==null).sort((a,b)=>a-b);
  el('rrqi-aadt').textContent=counts.length===0?'No nearby count':counts.length===1?`${counts[0].toLocaleString()} /day`:`${counts[0].toLocaleString()}–${counts[counts.length-1].toLocaleString()} /day`;
  el('rrqi-aadt-source').textContent=r.caltrans_station_distance_m!=null?`Caltrans station ${r.caltrans_station_distance_m} m away · route ${r.caltrans_route||'unknown'} · may be another road`:r.caltrans_error?`API unavailable: ${r.caltrans_error}`:'Only California state highways, no local-street count';
  el('rrqi-location-source').textContent=r.source==='mapillary'?'Mapillary image coordinates':r.latitude!=null?'Uploaded photo / entered coordinates':'Enter coordinates for local image';
}
function saveFile(filename,contents,mime){const blob=contents instanceof Blob?contents:new Blob([contents],{type:mime||'application/octet-stream'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function exportJson(){const records=Array.from(app.records.values());if(!records.length){dataStatus('No image records to export.',true);return;}
  saveFile('rrqi-image-records.json',JSON.stringify({project:'RRQI Explorer',exported_at:new Date().toISOString(),records},null,2),'application/json');
}
function exportCsv(){const records=Array.from(app.records.values());if(!records.length){dataStatus('No image records to export.',true);return;}
  const fields=['source','image_id','captured_at','latitude','longitude','elevation_m','elevation_source','osm_road_type','osm_road_name','osm_speed_limit','osm_lanes','osm_distance_m','road_exposure_proxy','road_exposure_note','caltrans_aadt_back','caltrans_aadt_ahead','caltrans_station_distance_m','caltrans_route','cv_segmentation_model','cv_objects_model','semantic_pixel_shares','detected_objects','image_url'];
  const cell=v=>`"${String(v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):v).replace(/"/g,'""')}"`;
  saveFile('rrqi-image-records.csv',fields.join(',')+'\n'+records.map(r=>fields.map(f=>cell(r[f])).join(',')).join('\n'),'text/csv;charset=utf-8');
}
function exportOverlay(){if(!app.imgReady){status('There is no image to save.',true);return;}
  const img=el('rrqi-analysis-image'),c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
  const ctx=c.getContext('2d');ctx.drawImage(img,0,0);
  for(const id of ['rrqi-segment-canvas','rrqi-objects-canvas']){const overlay=el(id);ctx.drawImage(overlay,0,0);}
  c.toBlob(blob=>blob?saveFile(`rrqi-${app.imageId||'photo'}-${app.mode}.png`,blob,'image/png'):status('Could not export annotated PNG.',true),'image/png');
}
// --------------------- User actions ---------------------
window.addEventListener('rrqi:imagechange',mapillaryImageSelected);
function openStandaloneLab(){
  document.getElementById('main-content').classList.add('viewer-open');
  document.getElementById('viewer-placeholder').classList.add('hidden');
  document.getElementById('viewer-tabs').classList.remove('hidden');
  document.getElementById('viewer-info-bar').classList.add('hidden');
  activateTab('vision');
  setTimeout(()=>window.__mlyMap?.resize(),400);
}
el('rrqi-open-lab').addEventListener('click',openStandaloneLab);
document.querySelectorAll('.rrqi-mode').forEach(b=>b.addEventListener('click',async()=>{
  const mode=b.dataset.mode;setMode(mode);
  if(mode!=='original'&&app.imgReady)await analyze(mode);
}));
el('rrqi-run-vision').addEventListener('click',async()=>{
  if(app.mode==='original')setMode('both');
  await analyze(app.mode);
});
el('rrqi-opacity').addEventListener('input',()=>{el('rrqi-opacity-value').textContent=el('rrqi-opacity').value+'%';redrawOverlays();});
el('rrqi-export-overlay').addEventListener('click',exportOverlay);
el('rrqi-export-csv').addEventListener('click',exportCsv);
el('rrqi-export-json').addEventListener('click',exportJson);
el('rrqi-refresh-data').addEventListener('click',()=>{app.lookupCache.clear();scheduleLookups();});
el('rrqi-local-file').addEventListener('change',(e)=>{const f=e.target.files?.[0];if(f)localImageChosen(f);e.target.value='';});
el('rrqi-sample').addEventListener('click',async()=>{
  try{const response=await fetch('sample-running-street.jpg');if(!response.ok)throw Error(`HTTP ${response.status}`);
    const blob=await response.blob();await localImageChosen(new File([blob],'sample-running-street.jpg',{type:'image/jpeg'}),true);
  }catch(err){status('Sample photo could not be loaded: '+err.message,true);}
});
el('rrqi-apply-coords').addEventListener('click',()=>{
  const lat=Number(el('rrqi-lat').value),lon=Number(el('rrqi-lon').value);
  if(!el('rrqi-lat').value||!el('rrqi-lon').value||!updateCoordinates(lat,lon))dataStatus('Enter valid latitude and longitude.',true);
});
el('rrqi-map-center').addEventListener('click',()=>{
  if(!window.__mlyMap)return dataStatus('The map is not ready.',true);
  const c=window.__mlyMap.getCenter();if(!app.record)beginRecord('coordinate','map-center-'+Date.now());
  updateCoordinates(c.lat,c.lng);dataStatus('Using the map center as a manually selected location.');
});
el('rrqi-map-help').addEventListener('click',()=>{
  alert('RRQI Explorer: click a green Mapillary image point, then open RRQI Vision for real semantic segmentation or object detection. RRQI Data shows open-source elevation and road information at that photo location. You can also upload a local image. Models download on first use and run in your browser.');
});
// exifr is optional: manual coordinate entry always works without it.
setMode('original');
