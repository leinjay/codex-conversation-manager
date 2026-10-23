const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {stopOwnedHost}=require('../dist/hostProcess');

async function fixture(t,ignoreTerm=false){
 const child=spawn(process.execPath,['-e',`${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''} console.log('ready');setInterval(()=>{},1000);`],{detached:true,stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 await once(child.stdout,'data');
 return child;
}
test('closing waits for only the owned child and is safe to repeat',async t=>{
 const first=await fixture(t);
 const unrelated=await fixture(t);
 await stopOwnedHost(first,500);
 assert.equal(first.signalCode,'SIGTERM');
 assert.equal(unrelated.exitCode,null);assert.equal(unrelated.signalCode,null);
 await stopOwnedHost(first,500);
 await stopOwnedHost(unrelated,500);
});
test('an owned process ignoring graceful close is killed before restart may continue',async t=>{
 const child=await fixture(t,true);
 await stopOwnedHost(child,50);
 assert.equal(child.signalCode,'SIGKILL');
});

const Module=require('node:module');const originalLoad=Module._load;
Module._load=function(request,parent,isMain){return request==='vscode'?{}:originalLoad.call(this,request,parent,isMain);};
const {Workbench}=require('../dist/extension');Module._load=originalLoad;
function workbench(){
 const instance=Object.create(Workbench.prototype);
 instance.runSession={id:'current',root:'/original/project',profile:'Debug',state:'running'};
 instance.refresh=async()=>{};
 instance.operation=async(_title,action)=>action(new AbortController().signal);
 return instance;
}
test('run controls reject stale cards and restart the original project/profile',async()=>{
 const instance=workbench();let restarted;
 instance.runSession.pid=123;
 instance.activeHost={pid:123,exitCode:null,signalCode:null};
 instance.selectedRoot='/different/project';
 instance.execute=async(action,profile,previous)=>{restarted={action,profile,root:previous.root};};
 await assert.rejects(instance.controlRun('Debug',true,'obsolete'),/运行状态已变化/);
 await assert.rejects(instance.controlRun('Release',false,'current'),/运行状态已变化/);
 assert.equal(restarted,undefined);
 await instance.controlRun('Debug',true,'current');
 assert.deepEqual(restarted,{action:'run',profile:'Debug',root:'/original/project'});
});
test('restart rejects hosts that have not started or have already exited',async()=>{
 const instance=workbench();let restarted=false;
 instance.execute=async()=>{restarted=true;};
 for(const state of ['preparing','building','starting','failed','exited']){
  instance.runSession.state=state;
  await assert.rejects(instance.controlRun('Debug',true,'current'),/尚未启动或已退出/);
 }
 instance.runSession.pid=123;
 instance.activeHost={pid:123,exitCode:0,signalCode:null};
 await assert.rejects(instance.controlRun('Debug',true,'current'),/尚未启动或已退出/);
 instance.activeHost={pid:123,exitCode:null,signalCode:'SIGTERM'};
 await assert.rejects(instance.controlRun('Debug',true,'current'),/尚未启动或已退出/);
 instance.activeHost={pid:456,exitCode:null,signalCode:null};
 await assert.rejects(instance.controlRun('Debug',true,'current'),/尚未启动或已退出/);
 assert.equal(restarted,false);
});
test('stop aborts a pending build and waits before closing',async()=>{
 const instance=workbench();const order=[];
 instance.busy=true;instance.abort=new AbortController();
 instance.refresh=async()=>new Promise(resolve=>setTimeout(resolve,20));
 instance.runTask=new Promise(resolve=>instance.abort.signal.addEventListener('abort',()=>{
   order.push('cancel');setTimeout(()=>{order.push('build-exited');instance.busy=false;instance.runTask=undefined;resolve();},10);
 }));
 instance.closeHost=async()=>{order.push('close');};
 await instance.controlRun('Debug',false,'current');
 assert.deepEqual(order,['cancel','build-exited','close']);
});
