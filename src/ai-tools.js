// AI stays behind an explicit activity-summary preview and send action.
export function createAITools({api,esc,modal,toast,navigate}) {
  const $ = selector => document.querySelector(selector);
  const ui = {config:null,models:[],status:'',busy:false,error:false};
  let reviewVersion = 0;

  async function load() {
    ui.config = await api('/ai/config');
    setModels({models:ui.config.models||[]});
    return ui.config;
  }
  function setModels(models) {
    ui.models = (models?.models || models || []).map(model=>typeof model==='string'?{id:model}:model).filter(model=>typeof model?.id==='string');
  }
  const host = value => {try{return new URL(value).host;}catch{return value||'API 服务';}};
  function options() {
    const models = [...ui.models];
    if(ui.config?.model&&!models.some(m=>m.id===ui.config.model))models.unshift({id:ui.config.model});
    return '<option value="">选择模型</option>'+models.map(m=>`<option value="${esc(m.id)}" ${ui.config?.model===m.id?'selected':''}>${esc(m.id)}</option>`).join('');
  }
  function settingsView() {
    const config=ui.config||{baseURL:'https://api.dsstl.xyz/v1',hasKey:false,model:''};
    return `<section class="panel ai-settings" id="ai-settings-panel" style="margin-top:20px"><div class="settings-section"><h3>AI 活动复盘</h3><p class="section-caption">从一次骑行的指标和区间表现，整理训练执行情况与下一次建议。</p><form id="ai-connection-form"><div class="form-grid"><label class="field">API 地址<input type="url" name="baseURL" value="${esc(config.baseURL)}" required spellcheck="false" autocomplete="off"></label><label class="field">API 密钥<input type="password" name="apiKey" value="" placeholder="${config.hasKey?'已保存 · 留空保留':'输入 API 密钥'}" autocomplete="new-password" spellcheck="false"></label></div><div class="actions" style="margin-top:12px"><button class="btn" type="submit" ${ui.busy?'disabled':''}>${ui.busy?'正在连接…':'连接并获取模型'}</button>${config.hasKey?'<button class="btn" type="button" data-ai-action="disconnect">移除连接</button>':''}</div><div class="form-grid" style="margin-top:18px"><label class="field">复盘模型<select name="model" aria-label="AI 复盘模型" ${!config.hasKey||ui.busy?'disabled':''}>${options()}</select></label><div class="actions" style="align-self:end"><button class="btn" type="button" data-ai-action="save-model" ${!config.hasKey||ui.busy?'disabled':''}>保存模型</button></div></div><p class="tiny" style="margin-top:10px">${config.model?`当前模型：${esc(config.model)}`:'获取列表后选择一个模型。'}</p><p id="ai-config-status" class="${ui.error?'builder-error':'tiny'}" role="status" style="margin-top:8px">${esc(ui.status)}</p></form><p class="tooltip-hint">密钥仅保存在本机，独立于训练备份。每次复盘前可查看将要发送的摘要。</p></div></section>`;
  }
  function redrawSettings() {
    const panel=$('#ai-settings-panel');
    if(panel)panel.outerHTML=settingsView();
  }
  function activityView(activity) {
    if(!activity||activity.planned||activity.type==='Note')return '';
    return `<button class="btn small" data-ai-action="review" data-ai-activity="${esc(activity.id)}">AI 复盘</button>`;
  }
  async function connect() {
    if(ui.busy)return;
    const form=$('#ai-connection-form');
    if(!form?.reportValidity())return;
    const values=new FormData(form);
    ui.busy=true;ui.error=false;ui.status='正在获取模型列表…';
    const payload={baseURL:String(values.get('baseURL')||'').trim(),apiKey:String(values.get('apiKey')||'').trim()};
    // Empty keys preserve an already saved local credential.
    const submit=form.querySelector('button[type=submit]');
    if(submit)submit.disabled=true;
    try {
      const oldURL=ui.config?.baseURL;
      ui.config=await api('/ai/config','PUT',payload);
      if(oldURL!==ui.config.baseURL)ui.models=[];
      const response=await api('/ai/models','POST',{});
      setModels(response);
      ui.status=ui.models.length?`已获取 ${ui.models.length} 个模型，请选择后保存。`:'已连接，服务未返回可用模型。';
    } catch(error) {
      ui.error=true;ui.status=error.message;
    } finally {
      if(form.elements.apiKey)form.elements.apiKey.value='';
      ui.busy=false;redrawSettings();
    }
  }
  async function saveModel() {
    const form=$('#ai-connection-form'),model=form?.elements.model?.value;
    if(!model)return toast('请选择一个模型');
    if(form.elements.baseURL.value.trim()!==ui.config?.baseURL)return toast('地址已修改，请先连接并获取模型');
    ui.config=await api('/ai/config','PUT',{model});
    ui.status='模型已保存';ui.error=false;redrawSettings();toast('复盘模型已保存');
  }
  async function disconnect() {
    if(ui.busy)return;
    ui.config=await api('/ai/config','DELETE');
    ui.models=[];ui.status='已移除本机 AI 连接';ui.error=false;
    reviewVersion++;redrawSettings();
  }
  function turnHTML(turn) {
    const date=new Date(turn.createdAt);
    const time=Number.isFinite(+date)?new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date):'';
    return `<article class="ai-turn"><div class="ai-question"><span class="tiny">你 · ${esc(time)}</span><p>${esc(turn.question)}</p></div><div class="ai-answer"><p class="tiny">${esc(turn.model)}</p><div class="ai-report">${turn.html}</div></div></article>`;
  }
  function scrollThread() {
    const list=$('#ai-review-thread');
    if(list)list.scrollTop=list.scrollHeight;
  }
  async function openReview(activityId) {
    const version=++reviewVersion;
    const [config,preview]=await Promise.all([load(),api(`/ai/context?activityId=${encodeURIComponent(activityId)}`)]);
    if(version!==reviewVersion)return;
    const {thread}=preview, ready=!!(config.hasKey&&preview.model), hasTurns=thread.turns.length>0;
    modal('AI 活动复盘',`<section id="ai-review" class="ai-review" data-activity-id="${esc(activityId)}" data-fingerprint="${esc(preview.fingerprint)}" data-revision="${esc(thread.revision)}">
      <div class="ai-review-bar"><span>${ready?`${esc(host(preview.baseURL))} · ${esc(preview.model)}`:'未配置复盘模型'}</span><button type="button" class="btn small" data-ai-action="clear-thread" ${hasTurns?'':'hidden'}>清空对话</button></div>
      <div id="ai-review-thread" class="ai-thread" role="log" aria-label="复盘对话" tabindex="0">${hasTurns?thread.turns.map(turnHTML).join(''):'<p class="ai-thread-empty">还没有复盘记录</p>'}</div>
      <form id="ai-review-form" class="ai-compose"><details class="ai-preview"><summary>发送内容：训练摘要<span id="ai-context-turns">${thread.contextTurns?`和最近 ${thread.contextTurns} 轮对话` : ''}</span></summary><pre class="ai-context">${esc(JSON.stringify(preview.context,null,2))}</pre></details>
      ${ready?`<label class="field"><span id="ai-question-label">${hasTurns?'继续追问':'问题（可选）'}</span><textarea id="ai-review-question" maxlength="2000" rows="2" placeholder="例如：最后一个区间掉了多少功率？" ${hasTurns?'required':''}></textarea></label>`:''}
      <div class="ai-compose-actions"><span id="ai-review-status" role="status" class="tiny"></span>${ready?`<button type="submit" class="btn primary" id="ai-send">${hasTurns?'发送追问':'发送摘要并生成复盘'}</button>`:'<button type="button" class="btn primary" data-ai-action="settings">打开 AI 设置</button>'}</div></form>
      </section>`,'',true);
    scrollThread();
  }
  async function generate() {
    const root=$('#ai-review');
    if(!root||root.dataset.busy==='true')return;
    const input=$('#ai-review-question'),question=input.value.trim();
    if(input.required&&!question){input.focus();return;}
    const {activityId,fingerprint:contextFingerprint,revision:threadRevision}=root.dataset;
    const version=reviewVersion;
    root.dataset.busy='true';
    const button=$('#ai-send'),status=$('#ai-review-status'),clear=root.querySelector('[data-ai-action=clear-thread]');
    button.disabled=true;input.readOnly=true;clear.disabled=true;
    status.textContent='正在分析本次活动…';status.className='tiny';
    try {
      const result=await api('/ai/review','POST',{activityId,question,contextFingerprint,threadRevision});
      if(version!==reviewVersion||root!==$('#ai-review'))return;
      root.dataset.revision=result.revision;
      $('#ai-context-turns').textContent=`和最近 ${result.contextTurns} 轮对话`;
      $('.ai-thread-empty')?.remove();
      const list=$('#ai-review-thread');
      list.insertAdjacentHTML('beforeend',turnHTML(result.turn));
      list.lastElementChild.scrollIntoView({block:'start'});
      input.value='';input.required=true;$('#ai-question-label').textContent='继续追问';
      button.textContent='发送追问';clear.hidden=false;
      status.textContent='已保存';
    } catch(error) {
      if(version!==reviewVersion||root!==$('#ai-review'))return;
      status.className='builder-error';
      status.textContent=error.message;
    } finally {
      root.dataset.busy='false';
      button.disabled=false;input.readOnly=false;clear.disabled=false;
    }
  }
  async function clearThread() {
    const root=$('#ai-review');
    if(!root||root.dataset.busy==='true'||!window.confirm('清空这项活动的全部复盘对话？'))return;
    const version=reviewVersion;
    await api(`/ai/thread?activityId=${encodeURIComponent(root.dataset.activityId)}`,'DELETE');
    if(version===reviewVersion){const trigger=root.dataset.activityId;$('#modal-root .modal-head button')?.click();await openReview(trigger);}
  }
  document.addEventListener('submit',event=>{
    if(event.target.id==='ai-connection-form'){event.preventDefault();connect();}
    if(event.target.id==='ai-review-form'){event.preventDefault();generate().catch(error=>toast(error.message));}
  });
  document.addEventListener('cycle-modal-close',()=>{reviewVersion++;});
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-ai-action]');
    if(!button||button.disabled)return;
    try {
      switch(button.dataset.aiAction) {
        case 'save-model':return await saveModel();
        case 'disconnect':return await disconnect();
        case 'review':return await openReview(button.dataset.aiActivity);
        case 'clear-thread':return await clearThread();
        case 'settings':await navigate('settings');$('#ai-settings-panel')?.scrollIntoView({block:'center'});return;
      }
    } catch(error){toast(error.message);}
  });
  return {load,setModels,settingsView,activityView,openReview};
}
