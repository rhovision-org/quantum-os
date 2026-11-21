// Executed inside the isolated Chromium origin by the CI witness.
// Real RTCDataChannels, real canvas MediaStreamTrack, actual PosixNet over
// a dedicated RTC transport. No physical camera, microphone or public peers.
export async function liveDevices(page){
 return page.evaluate(async()=>{
  const {QosCommand}=await import("/quantum-os/src/qos-command.ts");
  const {replayQosKernel}=await import("/quantum-os/src/qos-kernel.ts");
  const {newDynCapState}=await import("/quantum-os/src/dyncap.ts");
  const {dataChannelDriver,mediaTrackDriver,meshSocketDriver}=await import("/quantum-os/src/qos-device-host.ts");
  const {PosixNet}=await import("/quantum-os/src/posix-net.ts");
  const roomId="cap:room:03010563656127610341634101250325";
  const checks=[],assert=(name,value)=>{if(!value)throw Error(name);checks.push(name);};
  const a=new RTCPeerConnection({iceServers:[]}),b=new RTCPeerConnection({iceServers:[]});
  const canvas=document.createElement("canvas");canvas.width=64;canvas.height=32;
  canvas.getContext("2d").fillRect(0,0,64,32);
  const track=canvas.captureStream(5).getVideoTracks()[0];
  const identity=await newDynCapState(new Uint8Array(32).fill(153));
  let journal=null;
  const make=()=>new QosCommand({roomId,identity,transport:{broadcast:()=>{}},say:()=>{},
    loadJournal:()=>journal,saveJournal:events=>{journal=JSON.parse(JSON.stringify(events));}});
  let q=make();
  const replay=()=>replayQosKernel(q.room.log.events(),q.room.log.forkedSources);
  const run=async(line,op)=>{
    const old=new Set(replay().syscalls.map(t=>t.resultHash));await q.handle(line);
    if(!op)return;
    const t=replay().syscalls.find(t=>t.op===op&&!old.has(t.resultHash));
    if(!t)throw Error("missing receipt "+op);
    if(!t.outcome.ok)throw Error(op+" "+JSON.stringify(t.outcome));
    return t.outcome.value;
  };
  const wait=async(predicate)=>{const deadline=performance.now()+15000;while(!predicate()){if(performance.now()>deadline)throw Error("RTC deadline");await new Promise(r=>setTimeout(r,20));}};
  let remoteRaw,remoteSocket;
  const raw=a.createDataChannel("dedicated-device-raw"),wire=a.createDataChannel("dedicated-device-posix");
  b.ondatachannel=e=>{if(e.channel.label==="dedicated-device-raw")remoteRaw=e.channel;else if(e.channel.label==="dedicated-device-posix")remoteSocket=e.channel;};
  // Queue ICE until the remote description is present.
  const candidatesA=[],candidatesB=[];
  a.onicecandidate=e=>{if(e.candidate){if(b.remoteDescription)void b.addIceCandidate(e.candidate);else candidatesA.push(e.candidate);}};
  b.onicecandidate=e=>{if(e.candidate){if(a.remoteDescription)void a.addIceCandidate(e.candidate);else candidatesB.push(e.candidate);}};
  try{
   await a.setLocalDescription(await a.createOffer());await b.setRemoteDescription(a.localDescription);
   for(const c of candidatesA)await b.addIceCandidate(c);
   await b.setLocalDescription(await b.createAnswer());await a.setRemoteDescription(b.localDescription);
   for(const c of candidatesB)await a.addIceCandidate(c);
   await wait(()=>raw.readyState==="open"&&wire.readyState==="open"&&remoteRaw?.readyState==="open"&&remoteSocket?.readyState==="open");
   await run("start live");
   const allocate=async(kind,rights)=>{
    const d=await run("dev define live "+kind+" "+rights,"dev_define");
    const h=await run("dev open live "+d.handle.id+" "+rights,"dev_open");
    return {grant:d.handle.id,handle:h.handle.id};
   };
   const d=await allocate("data-channel",3);
   let bytesReceived=null,receivedCount=0;
   remoteRaw.binaryType="arraybuffer";remoteRaw.onmessage=e=>{bytesReceived=Array.from(new Uint8Array(e.data));receivedCount++;};
   assert("invalid donation cannot acquire a host resource",!await q.attachDevice("live","invalid","data-channel",()=>{throw Error("factory executed");}));
   assert("explicit RTC donation attaches to valid open handle",await q.attachDevice("live",d.handle,"data-channel",()=>dataChannelDriver(raw)));
   const record=(action,h,arg)=>run("dev "+action+" live "+h+" "+arg,"dev_observe").then(r=>r.observation);
   const write=await record("write",d.handle,"| 00ffabcd");await wait(()=>receivedCount===1);
   assert("real RTC binary write reaches dedicated remote endpoint",write.ok&&write.count===4&&JSON.stringify(bytesReceived)==="[0,255,171,205]");
   const arrived=new Promise(resolve=>raw.addEventListener("message",resolve,{once:true}));
   remoteRaw.send(Uint8Array.of(1,2,255));await arrived;
   const read=await record("read",d.handle,"3");
   assert("RTC driver records exact independently sent bytes",read.ok&&read.hex==="0102ff");
   // Actual POSIX socket handshake and framing, over a second real RTC channel.
   const transport=(self,channel)=>({selfId:self,pinNeighbor:()=>{},hasSocketChannel:()=>channel.readyState==="open",sendSocketFrame:(_peer,_kind,data)=>{if(channel.readyState!=="open")return false;channel.send(data);return true;}});
   const left=new PosixNet(transport("left",wire)),right=new PosixNet(transport("right",remoteSocket));
   wire.onmessage=e=>left.onTransportMessage("right","stream",e.data);
   remoteSocket.onmessage=e=>right.onTransportMessage("left","stream",e.data);
   let accepted,remotePayload=null,remoteClosed=false;
   right.listen(4201,"stream",socket=>{accepted=socket;socket.onData=x=>{remotePayload=x;};socket.onClose=()=>{remoteClosed=true;};});
   const socket=await left.connect("right",4201,"stream");await wait(()=>!!accepted);
   const m=await allocate("mesh-socket",3);
   assert("explicit socket donation uses actual PosixNet connection",await q.attachDevice("live",m.handle,"mesh-socket",()=>meshSocketDriver(socket)));
   const sent=await record("write",m.handle,"| 12fe");await wait(()=>remotePayload!==null);
   assert("real mesh stream transmits hex frame",sent.ok&&sent.count===2&&remotePayload==="12fe");
   const incoming=new Promise(resolve=>wire.addEventListener("message",resolve,{once:true}));
   accepted.send("00aa");await incoming;
   const mr=await record("read",m.handle,"2");
   assert("actual PosixNet inbound data becomes kernel observation",mr.ok&&mr.hex==="00aa");
   const t=await allocate("media-track",1);
   assert("explicit synthetic video track donation",await q.attachDevice("live",t.handle,"media-track",()=>mediaTrackDriver(track)));
   const media=await record("read",t.handle,"512");
   const meta=JSON.parse(new TextDecoder().decode(Uint8Array.from(media.hex.match(/../g),x=>parseInt(x,16))));
   assert("real MediaStreamTrack metadata is observed",media.ok&&meta.kind==="video"&&meta.readyState==="live"&&meta.width===64&&meta.height===32);
   const pid=q.list()[0].id;
   await run("syscall live | cap_revoke | "+JSON.stringify({handle:t.grant}),"cap_revoke");
   assert("grant revocation stops real MediaStreamTrack",track.readyState==="ended");
   await run("dev close live "+m.handle,"dev_close");await wait(()=>remoteClosed);
   assert("closing mesh device sends real FIN to peer",remoteClosed);
   const digest=await replay().kernel.stateDigest();
   await q.releaseDevices();await wait(()=>raw.readyState==="closed"&&remoteRaw.readyState==="closed");
   assert("room shutdown releases dedicated real RTC channel",raw.readyState==="closed");
   q=make();await q.handle("whoami");
   assert("fresh command adapter replays same digest without retransmission",await replay().kernel.stateDigest()===digest&&receivedCount===1);
   const absent=await record("read",d.handle,"3");
   assert("restored RTC handle has no ambient host attachment",absent.errno==="ENOTSUP");
   return checks;
  }finally{await q.releaseDevices();track.stop();a.close();b.close();}
 });
}
