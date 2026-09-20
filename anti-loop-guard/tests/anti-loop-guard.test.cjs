const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
// 与 pi-long-command-guard/tests/test-support.cjs 相同的加载约定：
// typescript 从 pi-web 工作区解析（可用 PI_BG_TEST_WORKSPACE 覆盖），
// transpileModule 把 .ts 编译成 CJS 后在 vm 沙箱执行；裸模块 import 一律走 require mock。
const workspace=process.env.PI_BG_TEST_WORKSPACE || 'C:/Users/10740/Documents/pi-web';
const workspaceRequire=createRequire(path.join(workspace,'package.json'));
const ts=workspaceRequire('typescript');
const source=path.resolve(__dirname,'../extensions/anti-loop-guard.ts');
function load(file=source,dependencies={},globals={}) {
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
  const errors=(code.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
  if(errors.length) throw new Error(errors.map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')).join('\n'));
  const sandbox={
    exports:{},Buffer,console,
    require(id){
      if(Object.hasOwn(dependencies,id)) return dependencies[id];
      if(id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected dependency ${id} from ${file}`);
    },...globals,
  };
  vm.runInNewContext(code.outputText,sandbox,{filename:file});
  return sandbox.exports;
}
function create(options={}) {
  const mod=load(source,{}, {process:{platform:options.platform || 'win32',env:options.env || {},stderr:{write(){}}}});
  const make=()=>{const callbacks={};mod.default({on:(name,fn)=>{callbacks[name]=fn;}});return callbacks;};
  const callbacks=make();
  return {mod,callbacks,make,
    call:(toolName,input)=>callbacks.tool_call?.({toolName,input},{cwd:'C:/work dir'}),
    result:(toolName,input,content,extra={})=>callbacks.tool_result?.({toolName,input,content,...extra},{cwd:'C:/work dir'}),
    sessionStart:()=>callbacks.session_start?.({reason:'startup'},{cwd:'C:/work dir'})};
}
test('1) same tool+input 3 times: 1st passes, 2nd blocked, 3rd blocked with terminate',()=>{
  const f=create();
  const input={url:'https://example.com/page'};
  assert.equal(f.call('web_fetch',input),undefined,'1st call must pass');
  const r2=f.call('web_fetch',input);
  assert.equal(r2.block,true,'2nd call must be blocked');
  assert.notEqual(r2.terminate,true,'2nd call must not terminate');
  assert.match(r2.reason,/web_fetch/,'reason must name the tool');
  assert.match(r2.reason,/已用相同参数调用 1 次/,'reason must state previous count');
  assert.match(r2.reason,/不要再用相同参数重复该调用/,'reason must contain the explicit instruction');
  const r3=f.call('web_fetch',input);
  assert.equal(r3.block,true,'3rd call must be blocked');
  assert.equal(r3.terminate===true,true,'3rd call must terminate');
  assert.match(r3.reason,/已用相同参数调用 2 次/);
});
test('2) different input keys are independent and non-adjacent repeats are allowed',()=>{
  const f=create();
  const a={url:'https://example.com/a'},b={url:'https://example.com/b'};
  assert.equal(f.call('web_fetch',a),undefined);
  assert.equal(f.call('web_fetch',b),undefined,'2nd key, 1st call must pass');
  assert.equal(f.call('web_fetch',b).block,true,'key b counts on its own (adjacent repeat)');
  // a 与 b 不同参 → streak 重置为 1，且上次结果未判定无效 → 合法重试，不能拦
  assert.equal(f.call('web_fetch',a),undefined,'non-adjacent repeat of a must pass');
});
test('2b) retrying the same call after an unhelpful result is blocked even when not adjacent',()=>{
  const f=create();
  const input={url:'https://example.com/broken'};
  assert.equal(f.call('web_fetch',input),undefined);
  assert.ok(f.result('web_fetch',input, [{type:'text',text:'Please enable JavaScript to continue.'}]),'invalid page is rewritten');
  assert.equal(f.call('read',{path:'other.txt'}),undefined,'interleaved different call resets the streak');
  const retry=f.call('web_fetch',input);
  assert.equal(retry.block,true,'retry after unhelpful result must be blocked');
  assert.match(retry.reason,/上次同类调用返回的结果已判定为无效/,'reason must state the actual trigger');
  assert.notEqual(retry.terminate,true,'non-adjacent retry must not terminate the turn');
});
test('2c) legitimate re-read after an edit is never blocked',()=>{
  const f=create();
  const file={path:'C:/work dir/src/app.ts'};
  assert.equal(f.call('read',file),undefined);
  f.result('read',file, [{type:'text',text:'x'.repeat(400)}]);
  assert.equal(f.call('edit',{path:'C:/work dir/src/app.ts',oldText:'a',newText:'b'}),undefined,'edit is a different key');
  assert.equal(f.call('read',file),undefined,'re-reading the edited file must pass');
  assert.equal(f.call('powershell',{command:'git status'}),undefined);
  assert.equal(f.call('read',{path:'C:/work dir/package.json'}),undefined,'unrelated call in between');
  assert.equal(f.call('powershell',{command:'git status'}),undefined,'same command with an unrelated call in between must pass');
});
test('3) invalid short web_fetch result -> isError true, hint text, image kept',()=>{
  const f=create();
  const input={url:'https://example.com/short'};
  const image={type:'image',data:'QUJD',mimeType:'image/png'};
  const body='Just a moment... Checking your browser before accessing example.com.';
  const r=f.result('web_fetch',input, [{type:'text',text:body},image]);
  assert.ok(r,'invalid page must be rewritten');
  assert.equal(r.isError,true,'isError must be true');
  assert.ok(Array.isArray(r.content));
  const text=r.content.filter(c=>c.type==='text').map(c=>c.text).join('');
  assert.ok(text.includes('不要用相同参数重试'),'rewritten text must say 不要用相同参数重试');
  assert.ok(text.includes('Just a moment'),'original text must be preserved');
  const images=r.content.filter(c=>c.type==='image');
  assert.equal(images.length,1,'non-text items must be kept');
  assert.equal(images[0].type,'image');assert.equal(images[0].data,image.data);assert.equal(images[0].mimeType,image.mimeType);
});
test('3b) short but legitimate bodies are NOT rewritten (length alone must not trigger)',()=>{
  const f=create();
  for(const body of ['{"ok":true,"id":"a1"}','OK','404','<p>短文本接口返回</p>']){
    assert.equal(
      f.result('web_fetch',{url:'https://example.com/api?q='+encodeURIComponent(body)}, [{type:'text',text:body}]),
      undefined,
      `short legitimate body must stay untouched: ${body}`,
    );
  }
});
test('3c) a long page merely containing 403 is NOT rewritten',()=>{
  const f=create();
  const body=('详见错误码 403 的说明。'.repeat(120)); // 远超 MAX_INVALID_PAGE_CHARS
  assert.equal(f.result('web_fetch',{url:'https://example.com/doc'}, [{type:'text',text:body}]),undefined);
});
test('3e) a mid-size body (~300 chars, like the observed 76-token result) with an interception signature IS rewritten',()=>{
  const f=create();
  const body=(
    'Please enable JavaScript and cookies to continue. '+ 'This site requires JavaScript to render its content. '.repeat(4)
  );
  assert.ok(body.length>200 && body.length<1000,`fixture length must sit above the old 200-char gate, got ${body.length}`);
  const r=f.result('web_fetch',{url:'https://example.com/js'}, [{type:'text',text:body}]);
  assert.ok(r,'mid-size invalid page must be rewritten');
  assert.equal(r.isError,true);
  assert.ok(r.content.filter(c=>c.type==='text').map(c=>c.text).join('').includes('不要用相同参数重试'));
});
test('3d) an empty / bare-html shell is treated as invalid',()=>{
  const f=create();
  const r=f.result('web_fetch',{url:'https://example.com/empty'}, [{type:'text',text:'<!DOCTYPE html><html><head></head>'}]);
  assert.ok(r,'bare html shell must be rewritten');
  assert.equal(r.isError,true);
});
test('4) short result of non-whitelisted tool (read) is untouched',()=>{
  const f=create();
  assert.equal(f.result('read',{path:'a.txt'}, [{type:'text',text:'短'}]),undefined,'read short result must not be rewritten');
});
test('5) long web_fetch result is untouched',()=>{
  const f=create();
  assert.equal(f.result('web_fetch',{url:'https://example.com/long'}, [{type:'text',text:'x'.repeat(250)}]),undefined,'long result must not be rewritten');
});
test('6) session_start resets counters',()=>{
  const f=create();
  const input={url:'https://example.com/reset'};
  assert.equal(f.call('web_fetch',input),undefined);
  assert.equal(f.call('web_fetch',input).block,true);
  f.sessionStart();
  assert.equal(f.call('web_fetch',input),undefined,'after session_start the same key passes again');
});
test('6b) session_start also clears the unhelpful/streak state',()=>{
  const f=create();
  const input={url:'https://example.com/reset2'};
  f.call('web_fetch',input);
  f.result('web_fetch',input, [{type:'text',text:'Attention Required! | Cloudflare'}]);
  f.sessionStart();
  assert.equal(f.call('web_fetch',input),undefined,'unhelpful evidence must not survive session_start');
});
test('7) block reason quotes the previous result excerpt',()=>{
  const f=create();
  const input={url:'https://example.com/excerpt'};
  assert.equal(f.call('web_fetch',input),undefined);
  assert.ok(f.result('web_fetch',input, [{type:'text',text:'CAPTCHA'}]),'short result recorded');
  const r2=f.call('web_fetch',input);
  assert.equal(r2.block,true);
  assert.match(r2.reason,/上次结果（前 7 字符）：CAPTCHA/,'reason must quote the stored excerpt');
});
test('7b) an isError result counts as unhelpful for any tool',()=>{
  const f=create();
  const cmd={command:'npm run build'};
  assert.equal(f.call('powershell',cmd),undefined);
  // 长文本 + isError：不该被改写，但要被记为「无效结果」
  assert.equal(f.result('powershell',cmd, [{type:'text',text:'x'.repeat(300)}],{isError:true}),undefined);
  assert.equal(f.call('read',{path:'a.txt'}),undefined,'interleaved call resets the streak');
  const retry=f.call('powershell',cmd);
  assert.equal(retry.block,true,'retry after an error result must be blocked for any tool');
  assert.match(retry.reason,/上次同类调用返回的结果已判定为无效/);
});
test('8) factory state is instance-local, like the guard tests',()=>{
  const f=create();
  f.call('web_fetch',{url:'https://example.com/x'});
  f.call('web_fetch',{url:'https://example.com/x'});
  const other=f.make();
  assert.equal(other.tool_call({toolName:'web_fetch',input:{url:'https://example.com/x'}},{cwd:'C:/work'}),undefined,'fresh instance starts at count 0');
});
test('typecheck (strict, same convention as pi-long-command-guard/tests/typecheck.cjs)',()=>{
  const options={
    noEmit:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,
    skipLibCheck:true,esModuleInterop:true,strict:true,allowImportingTsExtensions:true,baseUrl:workspace,
    paths:{'*':[path.join(workspace,'node_modules/*').replace(/\\/g,'/')]},
    typeRoots:[path.join(workspace,'node_modules/@types')],types:['node'],
  };
  const program=ts.createProgram([source],options);
  const diagnostics=ts.getPreEmitDiagnostics(program);
  for(const d of diagnostics){
    const location=d.file && d.start!==undefined ? d.file.getLineAndCharacterOfPosition(d.start) : undefined;
    console.log(`${d.file?.fileName || '<config>'}${location?`:${location.line+1}:${location.character+1}`:''} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText,'\n')}`);
  }
  assert.equal(diagnostics.length,0,`typecheck must be clean, got ${diagnostics.length} diagnostics`);
});
