const app=document.querySelector('#app'),modal=document.querySelector('#modal'),modalContent=document.querySelector('#modalContent');
const DAYS=['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
const SLOTS=[['breakfast','Завтрак'],['lunch','Обед'],['snack','Перекус'],['dinner','Ужин']];
const DEFAULT_TARGET={kcal:1750,protein:131,fat:58,carbs:175};
const SLOT_SHARES={breakfast:.25,lunch:.30,snack:.15,dinner:.30};
function macrosFromCalories(kcal){return {kcal:Math.round(kcal),protein:Math.round(kcal*.30/4),fat:Math.round(kcal*.30/9),carbs:Math.round(kcal*.40/4)}}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let sb=null;
let currentUser=null;
let state=null;
let cloudTimer=null;
let syncing=false;
let syncAgain=false;
let suppressSync=true;
let authListenerAttached=false;
let cloudConnectPromise=null;
const SUPABASE_CDN='https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
const OFFLINE_USER_KEY='myFoodOfflineUser';
const SIGNED_OUT_KEY='myFoodExplicitlySignedOut';
const DB_NAME='MyFoodDB';
const DB_VERSION=1;

function openLocalDB(){
  return new Promise((resolve,reject)=>{
    if(!('indexedDB' in window)){resolve(null);return}
    const req=indexedDB.open(DB_NAME,DB_VERSION);
    req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains('kv'))db.createObjectStore('kv')};
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
async function idbSet(key,value){try{const db=await openLocalDB();if(!db)return;await new Promise((res,rej)=>{const tx=db.transaction('kv','readwrite');tx.objectStore('kv').put(value,key);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)});db.close()}catch(e){console.warn('IndexedDB write failed',e)}}
async function idbGet(key){try{const db=await openLocalDB();if(!db)return null;const val=await new Promise((res,rej)=>{const tx=db.transaction('kv','readonly');const r=tx.objectStore('kv').get(key);r.onsuccess=()=>res(r.result??null);r.onerror=()=>rej(r.error)});db.close();return val}catch(e){console.warn('IndexedDB read failed',e);return null}}
async function idbDelete(key){try{const db=await openLocalDB();if(!db)return;await new Promise((res,rej)=>{const tx=db.transaction('kv','readwrite');tx.objectStore('kv').delete(key);tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error)});db.close()}catch(e){console.warn('IndexedDB delete failed',e)}}
function dirtyKey(uid=currentUser?.id){return uid?`mealDirty:${uid}`:null}
function pendingChanges(){const k=dirtyKey();return k?Number(localStorage.getItem(k)||0):0}
function markDirty(){const k=dirtyKey();if(!k)return;const n=Math.min(999,Number(localStorage.getItem(k)||0)+1);localStorage.setItem(k,String(n));idbSet(k,n);updateSyncBadge()}
function clearDirty(){const k=dirtyKey();if(!k)return;localStorage.setItem(k,'0');idbSet(k,0);updateSyncBadge()}
function storeOfflineUser(user){if(!user?.id)return;const slim={id:user.id,email:user.email||'',user_metadata:user.user_metadata||{}};localStorage.removeItem(SIGNED_OUT_KEY);localStorage.setItem(OFFLINE_USER_KEY,JSON.stringify(slim));idbSet(OFFLINE_USER_KEY,slim)}
function readOfflineUser(){
  if(localStorage.getItem(SIGNED_OUT_KEY)==='1')return null;
  try{const own=JSON.parse(localStorage.getItem(OFFLINE_USER_KEY)||'null');if(own?.id)return own}catch{}
  // Миграция с v7-v10: Supabase уже мог сохранить сессию, хотя v12 ещё не создал свой offline-user.
  for(let i=0;i<localStorage.length;i++){
    const k=localStorage.key(i)||'';if(!/^sb-.+-auth-token$/.test(k))continue;
    try{const raw=JSON.parse(localStorage.getItem(k)||'null');const u=raw?.user||raw?.currentSession?.user||raw?.session?.user;if(u?.id){const slim={id:u.id,email:u.email||'',user_metadata:u.user_metadata||{}};localStorage.setItem(OFFLINE_USER_KEY,JSON.stringify(slim));return slim}}catch{}
  }
  // Последний резерв: старое локальное состояние с UUID в ключе.
  for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i)||'';const m=k.match(/^mealState:([0-9a-f-]{30,})$/i);if(!m)continue;try{const st=JSON.parse(localStorage.getItem(k)||'null');const name=st?.profiles?.[0]?.name||'Я';const slim={id:m[1],email:'',user_metadata:{name}};localStorage.setItem(OFFLINE_USER_KEY,JSON.stringify(slim));return slim}catch{}}
  return null;
}

function loadSupabaseLibrary(timeoutMs=4500){
  if(window.supabase)return Promise.resolve(true);
  if(window.__supabaseLoader)return window.__supabaseLoader;
  window.__supabaseLoader=new Promise(resolve=>{
    const s=document.createElement('script');s.src=SUPABASE_CDN;s.async=true;
    let done=false;const finish=v=>{if(done)return;done=true;clearTimeout(timer);resolve(v)};
    s.onload=()=>finish(!!window.supabase);s.onerror=()=>finish(false);document.head.appendChild(s);
    const timer=setTimeout(()=>finish(!!window.supabase),timeoutMs);
  });
  return window.__supabaseLoader;
}
async function ensureCloudClient(){
  if(sb)return sb;
  if(cloudConnectPromise)return cloudConnectPromise;
  cloudConnectPromise=(async()=>{
    const ok=await loadSupabaseLibrary();
    if(!ok||!window.supabase){setSyncStatus(currentUser?offlineStatusText():'Облако недоступно');return null}
    sb=window.supabase.createClient(window.SUPABASE_CONFIG.url,window.SUPABASE_CONFIG.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
    attachAuthListener();
    return sb;
  })();
  const out=await cloudConnectPromise;cloudConnectPromise=null;return out;
}
function offlineStatusText(){const n=pendingChanges();return n?`Офлайн · ${n} изм.`:'Офлайн'}
function updateSyncBadge(){const el=document.querySelector('#syncStatus');if(!el)return;const n=pendingChanges();if(n&&/Синхронизировано/.test(el.textContent||''))el.textContent=`Есть изменения · ${n}`;else if(n&&/Офлайн/.test(el.textContent||''))el.textContent=`Офлайн · ${n} изм.`}

function emptyState(userId,name='Я',target=DEFAULT_TARGET){const baseKcal=target?.kcal??DEFAULT_TARGET.kcal,t={...macrosFromCalories(baseKcal),...(target||{}),kcal:baseKcal};return {recipeIngredients:{},customRecipes:[],shopping:{},cookingDone:{},mealSkips:{},view:'today',targetMode:'auto',familyMembers:[],profiles:[{id:userId,name:name||'Я',target:t,plan:{},favorites:[],weight:'',note:''}],activeProfileId:userId}}
const profile=()=>state?.profiles?.[0];
const target=()=>profile()?.target||DEFAULT_TARGET;
const enabledFamily=()=>state?.familyMembers?.filter(x=>x.enabled!==false)||[];
const participants=()=>profile()?[profile(),...enabledFamily().map(m=>({...m,plan:profile().plan,favorites:[]}))]:[];
function personTarget(p){return p?.target||DEFAULT_TARGET}
function cacheKey(uid=currentUser?.id){return uid?`mealState:${uid}`:null}
function saveLocal(){const k=cacheKey();if(k&&state){localStorage.setItem(k,JSON.stringify(state));idbSet(k,state)}}
async function loadCachedState(uid){const k=cacheKey(uid);if(!k)return null;const fromDb=await idbGet(k);if(fromDb)return fromDb;try{return JSON.parse(localStorage.getItem(k)||'null')}catch{return null}}
function save(){saveLocal();if(!suppressSync){markDirty();scheduleCloudSync()}}

function mondayOf(date=new Date()){const d=new Date(date);d.setHours(12,0,0,0);const day=(d.getDay()+6)%7;d.setDate(d.getDate()-day);return d}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
function isoLocal(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function weekDates(){const m=mondayOf();return DAYS.map((_,i)=>isoLocal(addDays(m,i)))}
function dayByDate(date){const i=weekDates().indexOf(date);return i>=0?DAYS[i]:null}

function scheduleCloudSync(){clearTimeout(cloudTimer);cloudTimer=setTimeout(()=>syncAllToCloud(),900)}
async function syncAllToCloud({force=false}={}){
  if(!currentUser||!state||suppressSync)return false;
  if(!force&&!pendingChanges())return true;
  if(syncing){syncAgain=true;return false}
  syncing=true;
  try{
    const client=await ensureCloudClient();if(!client){setSyncStatus(offlineStatusText());return false}
    const {data:{session}}=await client.auth.getSession();if(!session?.user){setSyncStatus('Офлайн · нужен вход для синхронизации');return false}
    currentUser=session.user;storeOfflineUser(currentUser);
    const uid=currentUser.id,p=profile(),dates=weekDates();
    const profileRow={user_id:uid,name:p.name||'',calories:p.target.kcal,protein:p.target.protein,fat:p.target.fat,carbs:p.target.carbs};
    let {error}=await sb.from('profiles').upsert(profileRow,{onConflict:'user_id'});if(error)throw error;

    error=(await sb.from('meal_plans').delete().eq('user_id',uid).gte('meal_date',dates[0]).lte('meal_date',dates[6])).error;if(error)throw error;
    const mealRows=[];
    DAYS.forEach((day,i)=>SLOTS.forEach(([mealType])=>{const id=p.plan?.[day]?.[mealType];if(id)mealRows.push({user_id:uid,meal_date:dates[i],meal_type:mealType,dish_id:id})}));
    if(mealRows.length){error=(await sb.from('meal_plans').insert(mealRows)).error;if(error)throw error}

    error=(await sb.from('favorites').delete().eq('user_id',uid)).error;if(error)throw error;
    if(p.favorites.length){error=(await sb.from('favorites').insert(p.favorites.map(dish_id=>({user_id:uid,dish_id})))).error;if(error)throw error}

    error=(await sb.from('recipe_overrides').delete().eq('user_id',uid)).error;if(error)throw error;
    const overrides=Object.entries(state.recipeIngredients).map(([dish_id,ingredients])=>({user_id:uid,dish_id,data:{ingredients}}));
    if(overrides.length){error=(await sb.from('recipe_overrides').insert(overrides)).error;if(error)throw error}

    error=(await sb.from('shopping_state').delete().eq('user_id',uid)).error;if(error)throw error;
    const shopping=Object.entries(state.shopping).filter(([,checked])=>checked).map(([item_key])=>({user_id:uid,item_key,checked:true}));
    if(shopping.length){error=(await sb.from('shopping_state').insert(shopping)).error;if(error)throw error}

    error=(await sb.from('cooking_state').delete().eq('user_id',uid)).error;if(error)throw error;
    const cooking=Object.entries(state.cookingDone).filter(([,checked])=>checked).map(([task_key])=>({user_id:uid,task_key,checked:true}));
    if(cooking.length){error=(await sb.from('cooking_state').insert(cooking)).error;if(error)throw error}

    error=(await sb.from('user_settings').upsert({user_id:uid,settings:{view:state.view,targetMode:state.targetMode||'auto',familyMembers:state.familyMembers||[],customRecipes:state.customRecipes||[]}},{onConflict:'user_id'})).error;if(error)throw error;
    clearDirty();setSyncStatus('Синхронизировано');return true;
  }catch(e){console.error('Supabase sync failed',e);setSyncStatus(offlineStatusText());return false}
  finally{syncing=false;if(syncAgain){syncAgain=false;scheduleCloudSync()}}
}

async function loadCloudState(user){
  const uid=user.id,dates=weekDates();
  const cached=await loadCachedState(uid);
  try{
    const [pr,mp,fv,ro,ss,cs,us]=await Promise.all([
      sb.from('profiles').select('name,calories,protein,fat,carbs').eq('user_id',uid).maybeSingle(),
      sb.from('meal_plans').select('meal_date,meal_type,dish_id').eq('user_id',uid).gte('meal_date',dates[0]).lte('meal_date',dates[6]),
      sb.from('favorites').select('dish_id').eq('user_id',uid),
      sb.from('recipe_overrides').select('dish_id,data').eq('user_id',uid),
      sb.from('shopping_state').select('item_key,checked').eq('user_id',uid),
      sb.from('cooking_state').select('task_key,checked').eq('user_id',uid),
      sb.from('user_settings').select('settings').eq('user_id',uid).maybeSingle()
    ]);
    const firstError=[pr,mp,fv,ro,ss,cs,us].find(x=>x.error)?.error;if(firstError)throw firstError;
    const meta=user.user_metadata||{};
    const pData=pr.data||{};
    const st=emptyState(uid,pData.name||meta.name||user.email?.split('@')[0]||'Я',{kcal:pData.calories,protein:pData.protein,fat:pData.fat,carbs:pData.carbs});
    const p=st.profiles[0];
    (mp.data||[]).forEach(row=>{const day=dayByDate(row.meal_date);if(day){p.plan[day]??={};p.plan[day][row.meal_type]=row.dish_id}});
    p.favorites=(fv.data||[]).map(x=>x.dish_id);
    (ro.data||[]).forEach(x=>{if(Array.isArray(x.data?.ingredients))st.recipeIngredients[x.dish_id]=x.data.ingredients});
    (ss.data||[]).forEach(x=>{if(x.checked)st.shopping[x.item_key]=true});
    (cs.data||[]).forEach(x=>{if(x.checked)st.cookingDone[x.task_key]=true});
    st.view=us.data?.settings?.view||'today';
    st.targetMode=us.data?.settings?.targetMode||'auto';
    st.familyMembers=Array.isArray(us.data?.settings?.familyMembers)?us.data.settings.familyMembers:[];
    st.customRecipes=Array.isArray(us.data?.settings?.customRecipes)?us.data.settings.customRecipes:[];
    if(st.targetMode==='auto')p.target=macrosFromCalories(p.target.kcal);
    st.familyMembers=st.familyMembers.map(m=>({...m,targetMode:m.targetMode||'auto',target:(m.targetMode||'auto')==='auto'?macrosFromCalories(m.target?.kcal||1750):(m.target||macrosFromCalories(1750)),enabled:m.enabled!==false}));
    state=st;saveLocal();clearDirty();setSyncStatus('Синхронизировано');
    return {remoteEmpty:!(mp.data||[]).length&&!(fv.data||[]).length&&!(ro.data||[]).length};
  }catch(e){
    console.error('Cloud load failed',e);setSyncStatus('Офлайн');
    state=cached||emptyState(uid,user.user_metadata?.name||user.email?.split('@')[0]||'Я');
    return {remoteEmpty:false,offline:true};
  }
}

function legacySnapshot(){
  try{const legacy=JSON.parse(localStorage.getItem('mealState')||'null');if(!legacy)return null;const p=Array.isArray(legacy.profiles)?legacy.profiles.find(x=>x.id===legacy.activeProfileId)||legacy.profiles[0]:null;return {name:p?.name||'Я',target:p?.target||DEFAULT_TARGET,plan:p?.plan||legacy.plan||{},favorites:p?.favorites||legacy.favorites||[],recipeIngredients:legacy.recipeIngredients||{},shopping:legacy.shopping||{},cookingDone:legacy.cookingDone||{}}}catch{return null}
}
function offerLegacyMigration(){const legacy=legacySnapshot();if(!legacy||localStorage.getItem('mealLegacyClaimed'))return;modalContent.innerHTML=`<span class="eyebrow">Переход на аккаунт</span><h2>Найдены данные предыдущей версии</h2><p class="note">Можно перенести ваше текущее меню, избранное, личные граммовки и отметки в этот аккаунт. После переноса они будут доступны только этому пользователю.</p><div class="week-actions"><button class="btn" onclick="importLegacy()">Перенести</button><button class="btn secondary" onclick="skipLegacy()">Начать заново</button></div>`;modal.classList.remove('hidden')}
function importLegacy(){const l=legacySnapshot();if(l){const p=profile();p.name=l.name;p.target={...DEFAULT_TARGET,...l.target};p.plan=l.plan;p.favorites=l.favorites;state.recipeIngredients=l.recipeIngredients;state.shopping=l.shopping;state.cookingDone=l.cookingDone;localStorage.setItem('mealLegacyClaimed','1');saveLocal();suppressSync=false;syncAllToCloud();render()}modal.classList.add('hidden')}
function skipLegacy(){localStorage.setItem('mealLegacyClaimed','1');modal.classList.add('hidden')}

function setSyncStatus(text){const el=document.querySelector('#syncStatus');if(el){el.textContent=text;el.title='Статус синхронизации'}}
function setSignedInUI(on){document.body.classList.toggle('auth-mode',!on);document.querySelector('.bottom-nav').classList.toggle('hidden',!on);document.querySelector('#profileBtn').classList.toggle('hidden',!on)}
function appRedirectUrl(){return location.origin+location.pathname}
function authErrorMessage(e){const m=e?.message||String(e||'Ошибка');if(/Invalid login credentials/i.test(m))return'Неверный email или пароль.';if(/Email not confirmed/i.test(m))return'Сначала подтвердите email по ссылке из письма.';if(/Password should be/i.test(m))return'Пароль слишком короткий. Используйте минимум 6 символов.';return m}

function renderAuth(mode='login',message=''){
  setSignedInUI(false);
  const signup=mode==='signup';
  app.innerHTML=`<section class="auth-wrap"><div class="auth-card"><span class="eyebrow">Моя еда · v24</span><h2>${signup?'Создать аккаунт':'Войти'}</h2>${message?`<div class="auth-message">${esc(message)}</div>`:''}${signup?`<label class="field">Имя<input id="authName" autocomplete="name" placeholder="Как вас называть"></label>`:''}<label class="field">Email<input id="authEmail" type="email" autocomplete="email" placeholder="name@example.com"></label><label class="field">Пароль<input id="authPassword" type="password" autocomplete="${signup?'new-password':'current-password'}" placeholder="Минимум 6 символов"></label>${signup?`<label class="field">Повторите пароль<input id="authPassword2" type="password" autocomplete="new-password"></label>`:''}<button class="btn auth-primary" onclick="${signup?'signUp()':'signIn()'}">${signup?'Создать аккаунт':'Войти'}</button><button class="auth-link" onclick="renderAuth('${signup?'login':'signup'}')">${signup?'Уже есть аккаунт':'Создать аккаунт'}</button>${!signup?`<button class="auth-link" onclick="resetPassword()">Забыли пароль?</button>`:''}<p class="tiny-note">Первый вход и регистрация требуют доступа к Supabase. После входа приложение работает локально без сети/VPN и синхронизируется позже.</p></div></section>`;
}
async function signUp(){const name=document.querySelector('#authName').value.trim(),email=document.querySelector('#authEmail').value.trim(),password=document.querySelector('#authPassword').value,p2=document.querySelector('#authPassword2').value;if(!email||!password)return renderAuth('signup','Заполните email и пароль.');if(password!==p2)return renderAuth('signup','Пароли не совпадают.');const client=await ensureCloudClient();if(!client)return renderAuth('signup','Сервис аккаунтов сейчас недоступен. Для первой регистрации включите доступ к интернету/VPN и повторите.');const {data,error}=await client.auth.signUp({email,password,options:{data:{name:name||'Я'},emailRedirectTo:appRedirectUrl()}});if(error)return renderAuth('signup',authErrorMessage(error));if(!data.session)return renderAuth('login','Аккаунт создан. Проверьте почту и подтвердите email, затем войдите.');}
async function signIn(){const email=document.querySelector('#authEmail').value.trim(),password=document.querySelector('#authPassword').value;const client=await ensureCloudClient();if(!client)return renderAuth('login','Supabase сейчас недоступен. Первый вход на этом устройстве требует сети/VPN.');const {error}=await client.auth.signInWithPassword({email,password});if(error)renderAuth('login',authErrorMessage(error))}
async function resetPassword(){const email=document.querySelector('#authEmail')?.value.trim()||prompt('Email для восстановления пароля:');if(!email)return;const client=await ensureCloudClient();if(!client)return renderAuth('login','Для восстановления пароля сейчас нужен доступ к Supabase.');const {error}=await client.auth.resetPasswordForEmail(email,{redirectTo:appRedirectUrl()});renderAuth('login',error?authErrorMessage(error):'Письмо для восстановления пароля отправлено.')}
function showRecovery(){modalContent.innerHTML=`<h2>Новый пароль</h2><label class="field">Новый пароль<input id="newPassword" type="password" autocomplete="new-password"></label><button class="btn" onclick="updatePassword()">Сохранить пароль</button>`;modal.classList.remove('hidden')}
async function updatePassword(){const password=document.querySelector('#newPassword').value;const client=await ensureCloudClient();if(!client)return alert('Для смены пароля нужен доступ к Supabase.');const {error}=await client.auth.updateUser({password});if(error){alert(authErrorMessage(error));return}modal.classList.add('hidden');alert('Пароль изменён.')}
async function signOut(){await syncAllToCloud({force:true});const client=await ensureCloudClient();if(client)await client.auth.signOut();localStorage.setItem(SIGNED_OUT_KEY,'1');localStorage.removeItem(OFFLINE_USER_KEY);await idbDelete(OFFLINE_USER_KEY);currentUser=null;state=null;renderAuth('login','Вы вышли из аккаунта.')}

const allDishes=()=>[...DISHES,...(state?.customRecipes||[])];
const dish=id=>allDishes().find(d=>d.id===id);
function recipeDetail(id){const d=dish(id);if(d?.custom)return {ingredients:d.ingredientList||[],steps:d.steps||'Описание приготовления не заполнено.',storage:d.storage||'Условия хранения не указаны.',replacements:d.replacements||'',prepType:d.prepType||'fresh'};return RECIPE_DETAILS[id]||{ingredients:[],steps:'Описание приготовления не заполнено.',storage:'Условия хранения не указаны.',replacements:'',prepType:'fresh'}}
const currentDay=()=>DAYS[(new Date().getDay()+6)%7];
function slotTarget(key,p=profile()){const tar=personTarget(p);return tar.kcal*(SLOT_SHARES[key]||.25)}
function portionFactorFor(d,key,p=profile()){return d&&key?slotTarget(key,p)/d.kcal:1}
function portionFactor(d,key){return portionFactorFor(d,key,profile())}
function scaledDishFor(d,key,p=profile()){const f=portionFactorFor(d,key,p);return {factor:f,kcal:d.kcal*f,protein:d.protein*f,fat:d.fat*f,carbs:d.carbs*f}}
function scaledDish(d,key){return scaledDishFor(d,key,profile())}
function planTotalsForDay(day){const pp=profile().plan[day]||{};return SLOTS.reduce((a,[key])=>{const d=dish(pp[key]);if(!d)return a;const x=scaledDish(d,key);a.kcal+=x.kcal;a.protein+=x.protein;a.fat+=x.fat;a.carbs+=x.carbs;return a},{kcal:0,protein:0,fat:0,carbs:0})}
const totals=ids=>ids.map(dish).filter(Boolean).reduce((a,d)=>({kcal:a.kcal+d.kcal,protein:a.protein+d.protein,fat:a.fat+d.fat,carbs:a.carbs+d.carbs}),{kcal:0,protein:0,fat:0,carbs:0});
function macro(t,label,key){return `<div class="macro"><b>${Math.round(t[key])}</b><span>${label}</span></div>`}
function recipeIngredients(id){const d=dish(id);if(d?.custom)return d.ingredientList||[];return state.recipeIngredients[id]||RECIPE_DETAILS[id]?.ingredients||[]}
function scaledIngredientsFor(id,key,p=profile()){const f=key?portionFactorFor(dish(id),key,p):1;return recipeIngredients(id).map(x=>({...x,qty:Math.round(Number(x.qty||0)*f*10)/10}))}
function scaledIngredients(id,key){return scaledIngredientsFor(id,key,profile())}
function ingredientText(x){return `${esc(x.name)} — ${x.qty} ${x.unit||'г'}`}
function targetFormulaNote(){return state.targetMode==='auto'?`БЖУ рассчитаны по формуле 30/30/40: 30% калорий из белка, 30% из жиров, 40% из углеводов.`:`Используются собственные значения БЖУ. Калорийность и БЖУ могут математически не совпадать — это допустимо в пользовательском режиме.`}

function mealRow(day,key,label){const p=profile(),d=dish((p.plan[day]||{})[key]);if(!d)return `<div class="slot empty-slot" onclick="chooseMeal('${day}','${key}')"><span>${label}: <b>выбрать блюдо</b></span><button>＋</button></div>`;const x=scaledDish(d,key),eaters=participants().filter(person=>!isMealSkipped(person.id,day,key));return `<div class="slot meal-slot"><button class="meal-open" onclick="openDish('${d.id}','${day}','${key}')"><span><small>${label}</small><b>${esc(d.name)}</b><em>${Math.round(x.kcal)} ккал · Б ${Math.round(x.protein)} · едят: ${eaters.length}/${participants().length}</em></span></button><div class="meal-actions"><button class="replace-btn" onclick="chooseMeal('${day}','${key}')">заменить</button><button class="replace-btn" onclick="editMealAttendance('${day}','${key}')">кто ест</button><button class="replace-btn danger-mini" onclick="removeMeal('${day}','${key}')">убрать</button></div></div>`}

function isMealSkipped(personId,day,key){return !!state?.mealSkips?.[personId]?.[day]?.[key]}
function setMealSkipped(personId,day,key,skip){state.mealSkips??={};state.mealSkips[personId]??={};state.mealSkips[personId][day]??={};if(skip)state.mealSkips[personId][day][key]=true;else delete state.mealSkips[personId][day][key]}
function removeMeal(day,key){if(!confirm('Убрать этот приём пищи из плана для всех?'))return;delete (profile().plan[day]||{})[key];participants().forEach(p=>setMealSkipped(p.id,day,key,false));state.shopping={};state.cookingDone={};save();render()}
function editMealAttendance(day,key){const d=dish(profile().plan?.[day]?.[key]);if(!d)return;modalContent.innerHTML=`<span class="eyebrow">${day}</span><h2>${esc(d.name)}</h2><p class="note">Отметь, кто будет есть этот приём пищи дома. Выключенные участники не попадут в закупки и готовку.</p>${participants().map(p=>`<label class="family-row"><span><b>${esc(p.name)}</b><small>${isMealSkipped(p.id,day,key)?'не учитывать':'учитывать порцию'}</small></span><input type="checkbox" ${isMealSkipped(p.id,day,key)?'':'checked'} onchange="setAttendance('${p.id}','${day}','${key}',this.checked)"></label>`).join('')}<button class="btn danger-btn" onclick="removeMeal('${day}','${key}');modal.classList.add('hidden')">Убрать приём пищи у всех</button>`;modal.classList.remove('hidden')}
function setAttendance(personId,day,key,eats){setMealSkipped(personId,day,key,!eats);state.shopping={};state.cookingDone={};save();editMealAttendance(day,key);render()}
function renderToday(){const p=profile(),day=currentDay(),t=planTotalsForDay(day),tar=target();app.innerHTML=`<section class="hero"><span class="eyebrow">${esc(p.name)} · ${day}</span><h2>${Math.round(t.kcal)} / ${tar.kcal} ккал</h2><div class="macro-grid">${macro(t,'ккал','kcal')}${macro(t,'белок','protein')}${macro(t,'жиры','fat')}${macro(t,'углеводы','carbs')}</div><div class="progress"><i style="width:${Math.min(100,t.kcal/tar.kcal*100)}%"></i></div><p class="tiny-note">${targetFormulaNote()}</p></section><section class="section"><h2>Сегодня</h2>${SLOTS.map(([k,l])=>mealRow(day,k,l)).join('')}</section><section class="section"><button class="btn" onclick="randomizeDay('${day}')">Собрать день автоматически</button></section>`}
function favButtonHTML(d){const on=profile().favorites.includes(d.id);return `<button class="fav-card ${on?'active':''}" aria-label="${on?'Убрать из избранного':'В избранное'}" onclick="toggleFavoriteCard('${d.id}',event)">${on?'♥':'♡'}</button>`}
function cardHTML(d){return `<div class="card dish-card" onclick="openDish('${d.id}')"><div class="dish-main"><div class="dish-id">${d.id} · ${d.category}</div><div class="dish-title">${esc(d.name)}</div><div class="meta">${d.minutes} мин · Б ${d.protein} г</div><div class="tag-row">${d.tags.slice(0,4).map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div></div><div class="dish-side">${favButtonHTML(d)}<div class="kcal">${d.kcal}</div><div class="meta">ккал</div></div></div>`}
function renderLibrary(){const p=profile(),catalog=allDishes();const tagOptions=[...new Set(catalog.flatMap(d=>d.tags))].filter(t=>!['завтрак','основное','перекус','аварийное'].includes(t.toLowerCase())).sort((a,b)=>a.localeCompare(b,'ru'));app.innerHTML=`<section class="library-screen"><div class="day-head library-head"><h2>Библиотека заготовок</h2><button class="btn add-recipe-btn" onclick="editCustomRecipe()">＋ Новая заготовка</button></div><button class="floating-add-recipe" onclick="editCustomRecipe()" aria-label="Добавить новый рецепт">＋</button><div class="meta recipe-count-head">${catalog.length} заготовок · своих: ${(state.customRecipes||[]).length}</div><input id="search" class="search" placeholder="Найти заготовку, продукт или тег"><div class="chips" id="cats">${['Все','Завтрак','Основное','Перекус','Аварийное','Избранное'].map((x,i)=>`<button class="chip ${i===0?'active':''}" data-cat="${x}">${x==='Избранное'?'♥ Избранное':x}</button>`).join('')}</div><div class="filter-panel"><div class="filter-title">Фильтры</div><div class="chips compact"><button class="chip" data-quick="fast">≤ 10 мин</button><button class="chip" data-quick="p30">Белок ≥ 30 г</button><button class="chip" data-quick="p40">Белок ≥ 40 г</button><button class="chip" data-quick="freezer">Морозилка</button><button class="chip" data-quick="nocook">Без готовки</button></div><label class="filter-select">Тег<select id="tagFilter"><option value="">Любой</option>${tagOptions.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('')}</select></label><button class="text-btn" id="resetFilters">Сбросить фильтры</button></div><div id="dishCount" class="meta"></div><div id="dishList"></div></section>`;
 let cat='Все',quick=new Set();
 const draw=()=>{const q=document.querySelector('#search').value.toLowerCase().trim(),tag=document.querySelector('#tagFilter').value;const arr=catalog.filter(d=>{if(cat!=='Все'&&cat!=='Избранное'&&d.category!==cat)return false;if(cat==='Избранное'&&!p.favorites.includes(d.id))return false;if(tag&&!d.tags.includes(tag))return false;if(quick.has('fast')&&d.minutes>10)return false;if(quick.has('p30')&&d.protein<30)return false;if(quick.has('p40')&&d.protein<40)return false;if(quick.has('freezer')&&!d.tags.some(t=>t.toLowerCase().includes('мороз')))return false;if(quick.has('nocook')&&!d.tags.some(t=>t.toLowerCase().includes('без готовки')))return false;return !q||(d.name+' '+d.ingredients.join(' ')+' '+d.tags.join(' ')).toLowerCase().includes(q)});document.querySelector('#dishCount').textContent=`Найдено: ${arr.length}`;document.querySelector('#dishList').innerHTML=arr.map(cardHTML).join('')||'<div class="empty">Ничего не найдено. Фильтры иногда тоже перестараются.</div>'};
 document.querySelector('#search').oninput=draw;document.querySelector('#tagFilter').onchange=draw;document.querySelectorAll('[data-cat]').forEach(b=>b.onclick=()=>{cat=b.dataset.cat;document.querySelectorAll('[data-cat]').forEach(x=>x.classList.toggle('active',x===b));draw()});document.querySelectorAll('[data-quick]').forEach(b=>b.onclick=()=>{const k=b.dataset.quick;quick.has(k)?quick.delete(k):quick.add(k);b.classList.toggle('active',quick.has(k));draw()});document.querySelector('#resetFilters').onclick=()=>{cat='Все';quick.clear();document.querySelector('#search').value='';document.querySelector('#tagFilter').value='';document.querySelectorAll('[data-cat]').forEach((x,i)=>x.classList.toggle('active',i===0));document.querySelectorAll('[data-quick]').forEach(x=>x.classList.remove('active'));draw()};draw()}
function openDish(id,day='',key=''){const d=dish(id);if(!d)return;const r=recipeDetail(id),planned=Boolean(day&&key),p=profile();window._dishContext={id,day,key};const people=planned?participants():[p];const portionSections=planned?people.map(person=>{const x=scaledDishFor(d,key,person),ings=scaledIngredientsFor(id,key,person);return `<section class="section family-portion"><div class="day-head"><h3>${esc(person.name)}</h3><span class="meta">${Math.round(x.kcal)} ккал · ×${x.factor.toFixed(2)}</span></div><div class="macro-grid">${[['ккал',x.kcal],['Б',x.protein],['Ж',x.fat],['У',x.carbs]].map(z=>`<div class="macro"><b>${Math.round(z[1])}</b><span>${z[0]}</span></div>`).join('')}</div><ul class="ingredient-list">${ings.map(z=>`<li>${ingredientText(z)}</li>`).join('')}</ul></section>`}).join(''):'';const x=planned?scaledDishFor(d,key,p):{factor:1,kcal:d.kcal,protein:d.protein,fat:d.fat,carbs:d.carbs},ings=planned?[]:recipeIngredients(id);modalContent.innerHTML=`<span class="eyebrow">${d.id} · ${d.category}${planned?` · ${day}`:''}</span><h2 style="padding-right:44px">${esc(d.name)}</h2>${planned?`<div class="portion-banner"><b>Одно блюдо для семьи</b><span>Ниже отдельная порция каждого включённого участника</span></div>${portionSections}`:`<p class="tiny-note">Базовая порция рецепта. В плане граммовки автоматически масштабируются под калорийность каждого участника.</p><div class="macro-grid">${[['ккал',x.kcal],['Б',x.protein],['Ж',x.fat],['У',x.carbs]].map(z=>`<div class="macro"><b>${Math.round(z[1])}</b><span>${z[0]}</span></div>`).join('')}</div><section class="section"><div class="day-head"><h3>Ингредиенты · 1 базовая порция</h3><button class="chip" onclick="${d.custom?`editCustomRecipe('${id}')`:`editIngredients('${id}')`}">${d.custom?'✎ рецепт':'✎ база'}</button></div><ul class="ingredient-list">${ings.map(z=>`<li>${ingredientText(z)}</li>`).join('')}</ul></section>`}<p class="tiny-note">Крупы/паста/картофель указаны в готовом виде; мясо и рыба преимущественно в сыром.</p><section class="section"><h3>Приготовление</h3><p class="note">${esc(r.steps)}</p></section><section class="section"><h3>Хранение и заготовка</h3><p class="note">${esc(r.storage||'Ориентируйтесь на самый скоропортящийся компонент.')}</p></section>${r.replacements?`<section class="section"><h3>Замены</h3><p class="note">${esc(r.replacements)}</p></section>`:''}<section class="section"><h3>Теги</h3><div class="tag-row">${d.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join('')}</div></section><div class="row"><button class="btn" onclick="toggleFavorite('${id}')">${p.favorites.includes(id)?'♥ В избранном':'♡ В избранное'}</button><button class="btn secondary" onclick="addToToday('${id}')">Добавить сегодня</button></div>${d.custom?`<div class="row custom-actions"><button class="btn secondary" onclick="editCustomRecipe('${id}')">Редактировать рецепт</button><button class="btn danger-btn" onclick="deleteCustomRecipe('${id}')">Удалить</button></div>`:''}`;modal.classList.remove('hidden')}
function editIngredients(id){window._editingIngredients=recipeIngredients(id).map(x=>({...x}));const draw=()=>{modalContent.innerHTML=`<h2>Базовые граммовки · ${esc(dish(id).name)}</h2><p class="note">Количество на базовую порцию. Порция в меню затем автоматически масштабируется под текущую калорийность.</p><div>${window._editingIngredients.map((x,i)=>`<div class="ingredient-edit-row"><input value="${esc(x.name)}" oninput="_editingIngredients[${i}].name=this.value"><input type="number" min="0" step="1" value="${x.qty}" oninput="_editingIngredients[${i}].qty=Number(this.value)"><select onchange="_editingIngredients[${i}].unit=this.value">${['г','мл','шт','ст.л.','ч.л.','банка','уп.'].map(u=>`<option ${x.unit===u?'selected':''}>${u}</option>`).join('')}</select><button class="remove-ing" onclick="_editingIngredients.splice(${i},1);editIngredients('${id}')">×</button></div>`).join('')}</div><div class="week-actions"><button class="btn secondary" onclick="_editingIngredients.push({name:'',qty:0,unit:'г'});editIngredients('${id}')">＋ ингредиент</button><button class="btn" onclick="state.recipeIngredients['${id}']=_editingIngredients.filter(x=>x.name.trim());save();openDish('${id}')">Сохранить</button></div>`};draw()}
function toggleFavorite(id){const p=profile();p.favorites=p.favorites.includes(id)?p.favorites.filter(x=>x!==id):[...p.favorites,id];save();const c=window._dishContext||{id};openDish(id,c.day||'',c.key||'')}
function toggleFavoriteCard(id,event){event?.stopPropagation();const p=profile();p.favorites=p.favorites.includes(id)?p.favorites.filter(x=>x!==id):[...p.favorites,id];save();renderLibrary()}
function addToToday(id){const p=profile(),d=dish(id),key=d.category==='Завтрак'?'breakfast':d.category==='Перекус'?'snack':'dinner';p.plan[currentDay()]??={};p.plan[currentDay()][key]=id;save();modal.classList.add('hidden');render()}

function renderWeek(){
 const p=profile(),ts=DAYS.map(day=>planTotalsForDay(day)),filled=ts.filter(t=>t.kcal>0),avg=filled.length?Math.round(filled.reduce((a,t)=>a+t.kcal,0)/filled.length):0;
 const prefs=state.weekPreferences||defaultWeekPreferences();
 app.innerHTML=`<section><h2>Неделя · ${esc(p.name)}</h2><div class="week-actions"><button class="btn" onclick="openWeekBuilder()">Настроить и составить неделю</button><button class="btn secondary" onclick="randomizeMealPrepWeek()">Быстрый meal prep</button><button class="btn secondary" onclick="randomizeWeek()">Разнообразная неделя</button><button class="btn secondary" onclick="clearWeek()">Очистить</button></div>${filled.length?`<div class="week-summary">Среднее: <b>${avg} ккал/день</b> · ${filled.length}/7 дней</div>`:''}<p class="note"><b>Текущая настройка:</b> готовка ${prefs.cookSessions} раз(а) в неделю · ${prefs.repeatMode==='high'?'повторы допустимы':prefs.repeatMode==='medium'?'умеренные повторы':'минимум повторов'} · до ${prefs.maxMainDishes} основных блюд · заморозка ${prefs.allowFreezer?'разрешена':'выключена'} · рыба ${prefs.fishMeals||0} раз.</p>${DAYS.map(day=>{const t=planTotalsForDay(day);return `<div class="day"><div class="day-head"><b>${day}</b><span class="meta">${Math.round(t.kcal)} ккал · Б ${Math.round(t.protein)} · Ж ${Math.round(t.fat)} · У ${Math.round(t.carbs)}</span></div><div class="slots">${SLOTS.map(([k,l])=>mealRow(day,k,l)).join('')}</div></div>`}).join('')}</section>`
}
function clearWeek(){profile().plan={};state.cookingDone={};save();render()}
function customIngredientRowHTML(x={name:'',qty:0,unit:'г'}){return `<div class="ingredient-edit-row custom-ing-row"><input class="cr-ing-name" placeholder="Продукт" value="${esc(x.name||'')}"><input class="cr-ing-qty" type="number" min="0" step="0.1" placeholder="0" value="${Number(x.qty||0)}"><select class="cr-ing-unit">${['г','мл','шт','ст.л.','ч.л.','банка','уп.'].map(u=>`<option ${x.unit===u?'selected':''}>${u}</option>`).join('')}</select><button class="remove-ing" type="button" onclick="this.closest('.custom-ing-row').remove()">×</button></div>`}
function addCustomIngredientRow(x){const box=document.querySelector('#customIngredients');if(box)box.insertAdjacentHTML('beforeend',customIngredientRowHTML(x||{name:'',qty:0,unit:'г'}))}
function editCustomRecipe(id=''){
 const d=id?dish(id):null;if(d&&!d.custom)return;
 const meta=d?.prepInfo||{mode:'batch_full',prepMinutes:d?.minutes||30,shelfDays:3,freezer:false};
 modalContent.innerHTML=`<span class="eyebrow">${d?'Мой рецепт':'Новый рецепт'}</span><h2>${d?'Редактировать рецепт':'Добавить рецепт'}</h2><label class="field">Название<input id="crName" value="${esc(d?.name||'')}"></label><div class="target-grid"><label class="field">Категория<select id="crCategory" class="select">${['Завтрак','Основное','Перекус','Аварийное'].map(c=>`<option ${d?.category===c?'selected':''}>${c}</option>`).join('')}</select></label><label class="field">Время, мин<input id="crMinutes" type="number" min="1" value="${d?.minutes||20}"></label></div><h3>КБЖУ базовой порции</h3><div class="recipe-macro-edit"><label class="field">ккал<input id="crKcal" type="number" min="1" value="${d?.kcal||500}"></label><label class="field">Б, г<input id="crProtein" type="number" min="0" step="0.1" value="${d?.protein||30}"></label><label class="field">Ж, г<input id="crFat" type="number" min="0" step="0.1" value="${d?.fat||15}"></label><label class="field">У, г<input id="crCarbs" type="number" min="0" step="0.1" value="${d?.carbs||50}"></label></div><section class="section"><div class="day-head"><h3>Ингредиенты · 1 порция</h3><button class="chip" type="button" onclick="addCustomIngredientRow()">＋ продукт</button></div><div id="customIngredients">${(d?.ingredientList?.length?d.ingredientList:[{name:'',qty:0,unit:'г'}]).map(customIngredientRowHTML).join('')}</div></section><label class="field">Как приготовить<textarea id="crSteps" rows="5" placeholder="Пошагово опишите приготовление">${esc(d?.steps||'')}</textarea></label><label class="field">Хранение и заготовка<textarea id="crStorage" rows="3" placeholder="Например: холодильник до 3 дней, можно замораживать">${esc(d?.storage||'')}</textarea></label><label class="field">Замены<textarea id="crReplacements" rows="2" placeholder="Необязательно">${esc(d?.replacements||'')}</textarea></label><label class="field">Теги<input id="crTags" value="${esc((d?.tags||[]).filter(t=>t!==d?.category?.toLowerCase()).join(', '))}" placeholder="европейское, курица, быстро"></label><h3>План готовки</h3><label class="field">Тип подготовки<select id="crPrepMode" class="select"><option value="batch_full" ${meta.mode==='batch_full'?'selected':''}>Полностью заранее</option><option value="batch_components" ${meta.mode==='batch_components'?'selected':''}>Компоненты заранее</option><option value="fresh" ${meta.mode==='fresh'?'selected':''}>Готовить в день подачи</option><option value="daybefore" ${meta.mode==='daybefore'?'selected':''}>Готовить накануне</option><option value="assemble" ${meta.mode==='assemble'?'selected':''}>Только собрать</option></select></label><div class="target-grid"><label class="field">Активное время, мин<input id="crPrepMinutes" type="number" min="1" value="${meta.prepMinutes||d?.minutes||20}"></label><label class="field">Хранение, дней<input id="crShelfDays" type="number" min="0" max="30" value="${meta.shelfDays??3}"></label></div><label class="check-field"><input id="crFreezer" type="checkbox" ${meta.freezer?'checked':''}> Можно замораживать</label><div class="week-actions"><button class="btn" onclick="saveCustomRecipe('${id}')">Сохранить рецепт</button><button class="btn secondary" onclick="modal.classList.add('hidden')">Отмена</button></div>`;modal.classList.remove('hidden')
}
function saveCustomRecipe(id=''){
 const name=document.querySelector('#crName')?.value.trim();if(!name){alert('Введите название блюда.');return}
 const category=document.querySelector('#crCategory').value,ingredientList=[...document.querySelectorAll('.custom-ing-row')].map(row=>({name:row.querySelector('.cr-ing-name').value.trim(),qty:Number(row.querySelector('.cr-ing-qty').value)||0,unit:row.querySelector('.cr-ing-unit').value})).filter(x=>x.name);
 if(!ingredientList.length){alert('Добавьте хотя бы один ингредиент.');return}
 const tags=[category.toLowerCase(),...document.querySelector('#crTags').value.split(',').map(x=>x.trim()).filter(Boolean)];
 const obj={id:id||('МР_'+Date.now().toString(36)),custom:true,category,name,kcal:Number(document.querySelector('#crKcal').value)||1,protein:Number(document.querySelector('#crProtein').value)||0,fat:Number(document.querySelector('#crFat').value)||0,carbs:Number(document.querySelector('#crCarbs').value)||0,minutes:Number(document.querySelector('#crMinutes').value)||1,ingredients:ingredientList.map(x=>x.name),ingredientList,prep:'пользовательский рецепт',tags:[...new Set(tags)],steps:document.querySelector('#crSteps').value.trim(),storage:document.querySelector('#crStorage').value.trim(),replacements:document.querySelector('#crReplacements').value.trim(),prepType:'custom',prepInfo:{mode:document.querySelector('#crPrepMode').value,prepMinutes:Number(document.querySelector('#crPrepMinutes').value)||20,shelfDays:Number(document.querySelector('#crShelfDays').value)||0,freezer:document.querySelector('#crFreezer').checked}};
 state.customRecipes??=[];const i=state.customRecipes.findIndex(x=>x.id===obj.id);if(i>=0)state.customRecipes[i]=obj;else state.customRecipes.push(obj);state.shopping={};state.cookingDone={};save();renderLibrary();openDish(obj.id)
}
function deleteCustomRecipe(id){const d=dish(id);if(!d?.custom)return;if(!confirm(`Удалить рецепт «${d.name}»? Он также будет убран из текущего меню.`))return;state.customRecipes=(state.customRecipes||[]).filter(x=>x.id!==id);const p=profile();p.favorites=p.favorites.filter(x=>x!==id);Object.values(p.plan||{}).forEach(day=>Object.keys(day||{}).forEach(k=>{if(day[k]===id)delete day[k]}));delete state.recipeIngredients[id];state.shopping={};state.cookingDone={};save();modal.classList.add('hidden');renderLibrary()}

function chooseMeal(day,key){const desired=key==='breakfast'?'Завтрак':key==='snack'?'Перекус':'Основное';const arr=allDishes().filter(d=>d.category===desired||(key!=='breakfast'&&key!=='snack'&&d.category==='Аварийное'));const draw=q=>arr.filter(d=>(d.name+' '+d.ingredients.join(' ')+' '+d.tags.join(' ')).toLowerCase().includes(q.toLowerCase())).map(d=>{const x=scaledDish(d,key);return `<div class="card dish-card picker-row"><button class="picker-info" onclick="openDish('${d.id}','${day}','${key}')"><div class="dish-title">${esc(d.name)}</div><div class="meta">В плане: ${Math.round(x.kcal)} ккал · Б ${Math.round(x.protein)} · ×${x.factor.toFixed(2)}</div></button><button class="pick-btn" onclick="setMeal('${day}','${key}','${d.id}')">выбрать</button></div>`}).join('');modalContent.innerHTML=`<h2>Выбрать: ${SLOTS.find(s=>s[0]===key)[1]}</h2><input class="search" id="pickerSearch" placeholder="Поиск"><div id="pickerList">${draw('')}</div>`;modal.classList.remove('hidden');document.querySelector('#pickerSearch').oninput=e=>document.querySelector('#pickerList').innerHTML=draw(e.target.value)}
function setMeal(day,key,id){const p=profile();p.plan[day]??={};p.plan[day][key]=id;state.cookingDone={};save();modal.classList.add('hidden');render()}
function randomizeDay(day){const p=profile(),tar=target(),catalog=allDishes(),b=catalog.filter(d=>d.category==='Завтрак'),m=catalog.filter(d=>d.category==='Основное'),sn=catalog.filter(d=>d.category==='Перекус');let best,bestScore=1e99;for(let i=0;i<1600;i++){const pp={breakfast:b[Math.random()*b.length|0].id,lunch:m[Math.random()*m.length|0].id,snack:sn[Math.random()*sn.length|0].id,dinner:m[Math.random()*m.length|0].id};const t=SLOTS.reduce((a,[key])=>{const x=scaledDish(dish(pp[key]),key);a.protein+=x.protein;a.fat+=x.fat;a.carbs+=x.carbs;return a},{protein:0,fat:0,carbs:0});const score=Math.abs(t.protein-tar.protein)*5+Math.abs(t.fat-tar.fat)*4+Math.abs(t.carbs-tar.carbs)*2+(pp.lunch===pp.dinner?120:0);if(score<bestScore){bestScore=score;best=pp}}p.plan[day]=best;state.cookingDone={};save();render()}

const proteinFamily=d=>{const s=(d.tags.join(' ')+' '+d.ingredients.join(' ')).toLowerCase();if(s.includes('куриц'))return'Курица';if(s.includes('индей'))return'Индейка';if(s.includes('говя'))return'Говядина';if(s.includes('лосос'))return'Лосось';if(s.includes('тунец'))return'Тунец';if(s.includes('рыба'))return'Белая рыба';if(s.includes('кревет'))return'Креветки';if(s.includes('фалафель')||s.includes('чечев'))return'Бобовые';return'Другое'};
const carbFamily=d=>{const s=d.ingredients.join(' ').toLowerCase();if(s.includes('рис'))return'Рис';if(s.includes('картоф'))return'Картофель';if(s.includes('паста')||s.includes('лазан'))return'Паста';if(s.includes('булгур'))return'Булгур';if(s.includes('удон'))return'Удон';if(s.includes('пита')||s.includes('тортиль'))return'Лепёшки';return'Другое'};
const WEEK_TEMPLATES=[
 {proteins:['Курица','Индейка'],carbs:['Рис','Картофель','Паста'],label:'курица + индейка'},
 {proteins:['Курица','Говядина'],carbs:['Рис','Картофель','Паста'],label:'курица + говядина'},
 {proteins:['Курица','Лосось'],carbs:['Рис','Картофель','Булгур'],label:'курица + рыба'},
 {proteins:['Говядина','Индейка'],carbs:['Рис','Картофель','Паста'],label:'говядина + индейка'}
];


function defaultWeekPreferences(){return {cookSessions:2,repeatMode:'high',maxMainDishes:4,containerMeals:14,allowFreezer:true,fishMeals:1}}
function openWeekBuilder(){
 const x={...defaultWeekPreferences(),...(state.weekPreferences||{})};
 modalContent.innerHTML=`<span class="eyebrow">Конструктор недели</span><h2>Как будем готовить</h2><label class="field">Сколько раз готовить?<select id="wbSessions" class="select"><option value="1" ${x.cookSessions===1?'selected':''}>1 раз · воскресенье</option><option value="2" ${x.cookSessions===2?'selected':''}>2 раза · воскресенье и среда</option><option value="3" ${x.cookSessions===3?'selected':''}>3 раза · воскресенье, вторник и пятница</option></select></label><label class="field">Повторы блюд<select id="wbRepeat" class="select"><option value="high" ${x.repeatMode==='high'?'selected':''}>Повторы удобны</option><option value="medium" ${x.repeatMode==='medium'?'selected':''}>Немного повторов</option><option value="low" ${x.repeatMode==='low'?'selected':''}>Минимум повторов</option></select></label><div class="target-grid"><label class="field">Максимум основных блюд<input id="wbMaxDishes" type="number" min="2" max="10" value="${x.maxMainDishes}"></label><label class="field">Контейнерных приёмов пищи<input id="wbContainers" type="number" min="4" max="28" value="${x.containerMeals}"></label></div><label class="field">Рыба за неделю<select id="wbFish" class="select"><option value="0" ${x.fishMeals===0?'selected':''}>Не обязательно</option><option value="1" ${x.fishMeals===1?'selected':''}>1 приём пищи</option><option value="2" ${x.fishMeals===2?'selected':''}>2 приёма пищи</option><option value="3" ${x.fishMeals===3?'selected':''}>3 приёма пищи</option></select></label><label class="check-field"><input id="wbFreezer" type="checkbox" ${x.allowFreezer?'checked':''}> Можно использовать заморозку</label><p class="tiny-note">Настройки влияют на число партий, повторы и допустимые заготовки. Индивидуальные порции семьи рассчитываются после выбора блюд.</p><div class="week-actions"><button class="btn" onclick="saveWeekBuilderAndGenerate()">Составить неделю</button><button class="btn secondary" onclick="modal.classList.add('hidden')">Отмена</button></div>`;
 modal.classList.remove('hidden');
}
function saveWeekBuilderAndGenerate(){
 state.weekPreferences={cookSessions:Number(document.querySelector('#wbSessions').value)||2,repeatMode:document.querySelector('#wbRepeat').value,maxMainDishes:Number(document.querySelector('#wbMaxDishes').value)||4,containerMeals:Number(document.querySelector('#wbContainers').value)||14,allowFreezer:document.querySelector('#wbFreezer').checked,fishMeals:Number(document.querySelector('#wbFish').value)||0};
 modal.classList.add('hidden');randomizeMealPrepWeek(state.weekPreferences);
}

function randomizeMealPrepWeek(options){
 const prefs={...defaultWeekPreferences(),...(state.weekPreferences||{}),...(options||{})};state.weekPreferences=prefs;
 const p=profile(),catalog=allDishes();
 const batchBreakfast=catalog.filter(d=>d.category==='Завтрак').filter(d=>{const m=inferredPrepMeta(d.id);return m.mode==='batch_full'&&(m.shelfDays>=3||(prefs.allowFreezer&&m.freezer))});
 const quickBreakfast=catalog.filter(d=>d.category==='Завтрак'&&d.minutes<=10);
 const snacks=catalog.filter(d=>d.category==='Перекус');
 let eligible=catalog.filter(d=>d.category==='Основное').filter(d=>{const m=inferredPrepMeta(d.id);return m.mode==='batch_full'&&(m.shelfDays>=3||(prefs.allowFreezer&&m.freezer))});
 if(eligible.length<2){alert('В библиотеке недостаточно блюд, которые можно полностью приготовить заранее.');return}
 const isFish=d=>['Лосось','Тунец','Белая рыба','Креветки'].includes(proteinFamily(d));
 const shuffled=a=>[...a].sort(()=>Math.random()-.5);
 const targetDistinct=Math.max(2,Math.min(prefs.maxMainDishes,eligible.length));
 let chosen=[],attempt=0;
 while(attempt++<80){
   const pool=shuffled(eligible),candidate=[];
   if(prefs.fishMeals>0){const fish=pool.find(isFish);if(fish)candidate.push(fish)}
   for(const d of pool){if(candidate.some(x=>x.id===d.id))continue;candidate.push(d);if(candidate.length>=targetDistinct)break}
   const sig=candidate.map(x=>x.id).sort().join('|');
   if(sig!==state.lastMealPrepSignature||attempt>60){chosen=candidate;state.lastMealPrepSignature=sig;break}
 }
 if(!chosen.length)chosen=shuffled(eligible).slice(0,targetDistinct);
 const sessions=prefs.cookSessions===1?[{days:DAYS,session:'Воскресенье'}]:prefs.cookSessions===3?[{days:['Понедельник','Вторник'],session:'Воскресенье'},{days:['Среда','Четверг'],session:'Вторник'},{days:['Пятница','Суббота','Воскресенье'],session:'Пятница'}]:[{days:['Понедельник','Вторник','Среда'],session:'Воскресенье'},{days:['Четверг','Пятница','Суббота','Воскресенье'],session:'Среда'}];
 // Делим выбранные блюда между сессиями без пересечений. Одно и то же блюдо
 // может повторяться внутри своего блока, но не переезжает во вторую половину недели.
 const minPerSession=2;
 const requiredDistinct=Math.min(eligible.length,Math.max(targetDistinct,sessions.length*minPerSession));
 while(chosen.length<requiredDistinct){
   const extra=shuffled(eligible).find(d=>!chosen.some(x=>x.id===d.id));
   if(!extra)break;chosen.push(extra);
 }
 const sessionPools=sessions.map(()=>[]);
 chosen.forEach((d,i)=>sessionPools[i%sessions.length].push(d));
 sessionPools.forEach((pool,i)=>{
   if(pool.length)return;
   const fallback=eligible.find(d=>!sessionPools.flat().some(x=>x.id===d.id))||eligible[i%eligible.length];
   if(fallback)pool.push(fallback);
 });
 p.plan={};
 sessions.forEach((block,bi)=>{
   const pool=shuffled(sessionPools[bi]);
   const desiredRepeats=prefs.repeatMode==='high'?3:prefs.repeatMode==='medium'?2:1;
   const seq=[];pool.forEach(d=>{for(let i=0;i<desiredRepeats;i++)seq.push(d)});
   while(seq.length<block.days.length*2)seq.push(...shuffled(pool));
   let pos=0;
   block.days.forEach((day,di)=>{
     let lunch=seq[pos++%seq.length],dinner=seq[pos++%seq.length];
     if(pool.length>1&&dinner?.id===lunch?.id){dinner=pool.find(x=>x.id!==lunch.id)||dinner}
     const bfPool=(di===1&&quickBreakfast.length)?quickBreakfast:batchBreakfast;
     const breakfast=(bfPool.length?bfPool[Math.floor(Math.random()*bfPool.length)]:catalog.find(d=>d.category==='Завтрак'));
     const snack=snacks.length?snacks[Math.floor(Math.random()*snacks.length)]:null;
     p.plan[day]={breakfast:breakfast?.id,lunch:lunch?.id,snack:snack?.id,dinner:dinner?.id};
   });
 });
 state.planMode='meal_prep';state.mealSkips={};state.cookingDone={};state.shopping={};save();render();
}
function randomizeThreeDays(){randomizeMealPrepWeek()}
function randomizeWeek(){
 const p=profile(),catalog=allDishes(),sn=catalog.filter(d=>d.category==='Перекус'),breakfastBatch=['З09','З10','З11','З12'].map(dish).filter(Boolean);
 // Each block is intentionally built around only two protein bases and two side bases.
 // Mon-Wed: chicken + beef, rice + potato. Thu-Sat: chicken + beef, bulgur + potato. Sunday starts the next Sunday batch.
 const blocks=[['О01','О03','О17'],['О04','О24','О15'],['О01','О03','О17']].map(set=>set.map(dish).filter(Boolean));
 DAYS.forEach((day,di)=>{const block=di<3?0:di<6?1:2,within=di%3,mains=blocks[block].length?blocks[block]:catalog.filter(d=>d.category==='Основное').slice(0,3),bf=breakfastBatch[(block+within)%Math.max(1,breakfastBatch.length)]||catalog.find(d=>d.category==='Завтрак');p.plan[day]={breakfast:bf?.id,lunch:mains[within%mains.length]?.id,snack:sn[(block+within)%Math.max(1,sn.length)]?.id,dinner:mains[(within+1)%mains.length]?.id}});
 state.mealSkips={};state.cookingDone={};state.shopping={};save();render();
}

function selectedPlans(){const plan=profile()?.plan||{};return participants().flatMap(p=>DAYS.flatMap(day=>SLOTS.map(([mealType])=>({profile:p,day,mealType,id:plan[day]?.[mealType]})).filter(x=>x.id&&!isMealSkipped(p.id,day,x.mealType))))}
function shoppingItems(){const exact=new Map();selectedPlans().forEach(({profile:p,id,mealType})=>scaledIngredientsFor(id,mealType,p).forEach(x=>{const key=`${x.name}|${x.unit||'г'}`;exact.set(key,(exact.get(key)||0)+Number(x.qty||0))}));return [...exact.entries()].map(([key,qty])=>{const [name,unit]=key.split('|');return{name,unit,qty}}).filter(x=>x.qty>0).sort((a,b)=>a.name.localeCompare(b.name,'ru'))}
function householdToggleHTML(){const ps=participants();return `<div class="household-strip"><b>В расчёте:</b> ${ps.map(x=>`<span class="tag">${esc(x.name)} · ${x.target.kcal} ккал</span>`).join('')}</div>`}
function renderShopping(){const items=shoppingItems();app.innerHTML=`<section><h2>Покупки</h2>${householdToggleHTML()}<p class="note">Общий список для организатора и всех включённых членов семьи. Одинаковые продукты суммируются.</p>${items.map(x=>{const key=`${x.name}|${x.unit}`;return `<label class="shop-row ${state.shopping[key]?'done':''}"><input type="checkbox" ${state.shopping[key]?'checked':''} onchange="toggleShop('${key.replace(/'/g,"\\'")}')"><span>${esc(x.name)} <b>${Math.round(x.qty*10)/10} ${x.unit}</b></span></label>`}).join('')||'<div class="empty">Сначала составьте меню.</div>'}</section>`}
function toggleShop(k){state.shopping[k]=!state.shopping[k];save();renderShopping()}

function normName(s){return s.toLowerCase().replace(/ё/g,'е')}
function prepGroup(name){const s=normName(name);if(/курин|курица/.test(s))return['protein','Курица'];if(/индей/.test(s))return['protein','Индейка'];if(/говя/.test(s))return['protein','Говядина'];if(/лосос/.test(s))return['fresh','Лосось'];if(/белая рыба/.test(s))return['fresh','Белая рыба'];if(/кревет/.test(s))return['fresh','Креветки'];if(/рис/.test(s))return['carb','Рис'];if(/картоф/.test(s))return['carb','Картофель'];if(/паста|лазан/.test(s))return['carb','Паста'];if(/булгур/.test(s))return['carb','Булгур'];if(/удон/.test(s))return['carb','Удон'];if(/брокколи|морковь|перец|овощ|кабач|баклаж|шпинат/.test(s))return['veg','Овощи'];return null}
function aggregatePrep(){const map=new Map();selectedPlans().forEach(({profile:p,id,mealType})=>scaledIngredientsFor(id,mealType,p).forEach(x=>{if((x.unit||'г')!=='г')return;const g=prepGroup(x.name);if(!g)return;const [type,label]=g,key=type+'|'+label;const z=map.get(key)||{type,label,qty:0,examples:new Set()};z.qty+=Number(x.qty||0);z.examples.add(dish(id)?.name||id);map.set(key,z)}));return [...map.values()]}

function dayIndex(day){return Math.max(0,DAYS.indexOf(day))}
function previousDay(day){const i=dayIndex(day);return i===0?'Воскресенье':DAYS[i-1]}
function inferredPrepMeta(id){const d=dish(id),r=recipeDetail(id),explicit=d?.custom?(d.prepInfo||{}):((typeof PREP_META!=='undefined'&&PREP_META[id])||{});const txt=((r.storage||'')+' '+(d?.tags||[]).join(' ')).toLowerCase();let shelfDays=explicit.shelfDays||(/3\s*дн/.test(txt)?3:/2\s*дн/.test(txt)?2:3);const freezer=explicit.freezer!==undefined?explicit.freezer:/замораж|морозил/.test(txt);let mode=explicit.mode;if(!mode){if(r.prepType==='nocook')mode='assemble';else if(r.prepType==='daybefore')mode='daybefore';else if(r.prepType==='fresh')mode='fresh';else if(r.prepType==='batch')mode='batch_full';else mode='fresh'}return {...explicit,mode,shelfDays,freezer,prepMinutes:explicit.prepMinutes||Math.max(5,d?.minutes||15)}}
function mealAggregate(){const map=new Map();selectedPlans().forEach(({profile:p,day,mealType,id})=>{const key=[day,mealType,id].join('|'),z=map.get(key)||{day,mealType,id,d:dish(id),r:RECIPE_DETAILS[id]||{},people:[],ingredients:new Map(),totalFactor:0};const factor=portionFactorFor(dish(id),mealType,p);z.totalFactor+=factor;z.people.push({name:p.name,factor});scaledIngredientsFor(id,mealType,p).forEach(x=>{const k=normName(x.name)+'|'+(x.unit||'г'),q=z.ingredients.get(k)||{name:x.name,unit:x.unit||'г',qty:0};q.qty+=Number(x.qty||0);z.ingredients.set(k,q)});map.set(key,z)});return [...map.values()]}
function ingredientSummary(meal,max=7){const a=[...meal.ingredients.values()].filter(x=>x.qty>0).slice(0,max).map(x=>`${x.name} ${Math.round(x.qty*10)/10} ${x.unit}`);return a.join(' · ')+(meal.ingredients.size>max?' · …':'')}
function sessionForMeal(meal,meta){const i=dayIndex(meal.day);if(meta.mode==='daybefore')return previousDay(meal.day);if(meta.mode==='fresh'||meta.mode==='assemble')return meal.day;if(meta.mode==='batch_full'||meta.mode==='batch_components'){
  if(meta.freezer)return 'Воскресенье';
  // Sunday batch only covers meals that fit the chilled shelf life. Mid-week session covers the rest.
  if(i<=Math.max(0,meta.shelfDays-1))return 'Воскресенье';
  if(i>=3 && i<=3+Math.max(0,meta.shelfDays-1))return 'Среда';
  return meal.day;
 }return meal.day}
function taskAction(meal,meta){const d=meal.d,name=d?.name||meal.id,ings=ingredientSummary(meal);if(meta.mode==='assemble')return `Собрать ${name}. ${ings}`;if(meta.mode==='daybefore')return `Подготовить ${name} на следующий день. ${ings}`;if(meta.mode==='fresh')return `Полностью приготовить ${name} перед приёмом пищи. ${ings}`;if(meta.mode==='batch_components')return `${meta.note||`Подготовить основные компоненты для «${name}».`} ${ings}`;const freeze=meta.freezer?' Лишние порции после охлаждения заморозить и подписать днём подачи.':'';return `${meta.note||`Полностью приготовить «${name}» заранее, остудить и разложить по порциям.`}${freeze} ${ings}`}
function mergeMealTasks(meals){const map=new Map();meals.forEach(meal=>{const meta=inferredPrepMeta(meal.id),session=sessionForMeal(meal,meta),key=session+'|'+meal.id+'|'+meta.mode,z=map.get(key)||{session,id:meal.id,mode:meta.mode,meta,meals:[],minutes:0,ingredients:new Map()};z.meals.push(meal);z.minutes=Math.max(z.minutes,meta.prepMinutes||15);meal.ingredients.forEach((x,k)=>{const q=z.ingredients.get(k)||{...x,qty:0};q.qty+=x.qty;z.ingredients.set(k,q)});map.set(key,z)});return [...map.values()]}
function taskText(z){const d=dish(z.id),days=[...new Set(z.meals.map(x=>x.day))].join(', '),fake={...z.meals[0],ingredients:z.ingredients};return `${taskAction(fake,z.meta)} Подача: ${days}.`}
function sessionSort(a,b){const order={'Воскресенье':-1,'Понедельник':0,'Вторник':1,'Среда':2,'Четверг':3,'Пятница':4,'Суббота':5};return (order[a]??99)-(order[b]??99)}
function prepSessionForDay(day){const n=(state.weekPreferences||defaultWeekPreferences()).cookSessions;if(n===1)return 'Воскресенье';if(n===3){if(['Понедельник','Вторник'].includes(day))return 'Воскресенье';if(['Среда','Четверг'].includes(day))return 'Вторник';return 'Пятница'}return ['Понедельник','Вторник','Среда'].includes(day)?'Воскресенье':'Среда'}
function freshIngredient(name){return /(листь|салат|огур|авокад|зелень|руккол|шпинат свеж|томат свеж|помидор свеж|дзадзики|йогуртовый соус|сметана для подачи|лимон для подачи)/i.test(name||'')}
function containerIngredientsFor(id,mealType,p){return scaledIngredientsFor(id,mealType,p).filter(x=>!freshIngredient(x.name))}
function freshIngredientsFor(id,mealType,p){return scaledIngredientsFor(id,mealType,p).filter(x=>freshIngredient(x.name))}
function roundPrepGram(q){
 const n=Number(q||0);
 if(!Number.isFinite(n)||n<=0)return 0;
 return Math.max(5,Math.round(n/5)*5);
}
function containerWeight(ings){return roundPrepGram(ings.filter(x=>['г','мл'].includes(x.unit||'г')).reduce((s,x)=>s+Number(x.qty||0),0))}
function compactWeightBreakdown(values){const m=new Map();values.forEach(v=>m.set(v,(m.get(v)||0)+1));return [...m.entries()].sort((a,b)=>a[0]-b[0]).map(([g,n])=>`${n}×≈${g} г`).join(' + ')}
function aggregateIngredients(rows){const m=new Map();rows.flat().forEach(x=>{const k=x.name+'|'+(x.unit||'г');m.set(k,(m.get(k)||0)+Number(x.qty||0))});return [...m.entries()].map(([k,q])=>{const [name,unit]=k.split('|');return `${name} ${unit==='г'||unit==='мл'?roundPrepGram(q):Math.round(q*10)/10} ${unit}`}).join(' · ')}
function mealPrepBatches(){
 const map=new Map();
 selectedPlans().forEach(({profile:p,day,mealType,id})=>{
   const d=dish(id);if(!d)return;
   const isLongBreakfast=mealType==='breakfast'&&['З09','З10','З11','З12','З08'].includes(id);
   if(d.category!=='Основное'&&!isLongBreakfast)return;
   const session=prepSessionForDay(day),key=`${session}|${id}`;
   const z=map.get(key)||{session,id,mealType:'container',dish:d,containers:[],ingredientRows:[],days:new Set(),fresh:new Set()};
   const stable=containerIngredientsFor(id,mealType,p),fresh=freshIngredientsFor(id,mealType,p);
   z.containers.push({person:p.name,day,weight:containerWeight(stable),ingredients:stable});z.ingredientRows.push(stable);z.days.add(day);fresh.forEach(x=>z.fresh.add(x.name));map.set(key,z);
 });
 return [...map.values()];
}
function dailyFreshTasks(){
 const plan=profile()?.plan||{},groups=[];
 DAYS.forEach(day=>{const items=[];SLOTS.forEach(([mealType,label])=>{const id=plan[day]?.[mealType],d=dish(id);if(!d)return;const eaters=participants().filter(p=>!isMealSkipped(p.id,day,mealType));if(!eaters.length)return;
   const isContainer=d.category==='Основное'||(mealType==='breakfast'&&['З09','З10','З11','З12','З08'].includes(id));
   if(isContainer){const fresh=[...new Set(eaters.flatMap(p=>freshIngredientsFor(id,mealType,p).map(x=>x.name)))];items.push({key:`serve-${day}-${mealType}-${id}`,label:`${label} · ${d.name}`,text:fresh.length?`Взять готовый подписанный контейнер, разогреть при необходимости. Перед подачей добавить: ${fresh.join(', ')}.`:`Взять готовый подписанный контейнер и разогреть при необходимости. Больше готовить ничего не нужно.`});}
   else {const mins=d.minutes||10;items.push({key:`fresh-${day}-${mealType}-${id}`,label:`${label} · ${d.name}`,text:`Приготовить или собрать перед едой. Ориентировочно ${mins} мин.`});}
 });if(items.length)groups.push({title:`${day} · взять контейнер`,time:'0–10 мин',items})});return groups;
}
function cookingPlan(){
 const batches=mealPrepBatches();if(!selectedPlans().length)return[];const groups=[];
 const sessions=[...new Set(batches.map(x=>x.session))].sort(sessionSort);
 sessions.forEach(session=>{const xs=batches.filter(x=>x.session===session);if(!xs.length)return;const items=xs.map(x=>{const weights=compactWeightBreakdown(x.containers.map(c=>c.weight));const labels=x.containers.map(c=>`${c.day}: ${c.person}`).join(' · ');const r=recipeDetail(x.id)||{},fresh=[...x.fresh];return {key:`batch-${session}-${x.mealType}-${x.id}`,label:`${x.dish.name} · ${x.containers.length} контейнеров`,text:`Полностью приготовить блюдо и сразу разложить: ${weights}. Подписать: ${labels}. На всю партию: ${aggregateIngredients(x.ingredientRows)}. ${fresh.length?`Не класть заранее: ${fresh.join(', ')} — добавить в день подачи. `:''}Технология: ${r.steps||'Приготовить по карточке заготовки.'}`}});groups.push({title:`${session} · приготовить и упаковать`,time:'партия контейнеров',items})});
 return [...groups,...dailyFreshTasks()];
}
function renderCooking(){state.cookingDone??={};let groups=[];try{groups=cookingPlan()}catch(e){console.error('cookingPlan',e);app.innerHTML=`<section><h2>Готовка и контейнеры</h2><div class="empty">Не удалось построить план готовки: ${esc(e.message||String(e))}</div></section>`;return}app.innerHTML=`<section><h2>Готовка и контейнеры</h2>${householdToggleHTML()}<p class="note"><b>Готовим готовые блюда, а не отдельные компоненты.</b> В воскресенье упаковываем контейнеры на понедельник–среду, в среду — на четверг–воскресенье. Каждый контейнер уже содержит основную часть блюда в индивидуальной граммовке. Отдельно остаются только продукты, которые не переживут хранение, и быстрые завтраки.</p>${groups.length?groups.map(g=>`<div class="cook-block"><div class="day-head"><h3>${g.title}</h3><span class="meta">${g.time}</span></div>${g.items.map(x=>`<label class="cook-task ${state.cookingDone[x.key]?'done':''}"><input type="checkbox" ${state.cookingDone[x.key]?'checked':''} onchange="toggleCook('${x.key.replace(/'/g,"\\'")}')"><span><b>${esc(x.label)}</b><small>${esc(x.text)}</small></span></label>`).join('')}</div>`).join(''):'<div class="empty">Сначала составьте meal prep неделю.</div>'}</section>`}
function toggleCook(k){state.cookingDone??={};state.cookingDone[k]=!state.cookingDone[k];save();renderCooking()}

async function syncNow(){setSyncStatus('Синхронизация…');const ok=await syncAllToCloud({force:true});if(!ok)setSyncStatus(offlineStatusText())}
function exportData(){if(!state||!currentUser)return;const payload={format:'my-food-backup',version:18,exportedAt:new Date().toISOString(),user:{id:currentUser.id,email:currentUser.email||'',name:profile()?.name||'Я'},state};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`my-food-backup-${new Date().toISOString().slice(0,10)}.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}
function chooseImport(){const i=document.createElement('input');i.type='file';i.accept='application/json,.json';i.onchange=async()=>{const f=i.files?.[0];if(!f)return;try{const data=JSON.parse(await f.text());if(data?.format!=='my-food-backup'||!data.state)throw new Error('Неизвестный формат');if(!confirm('Импорт заменит локальные данные текущего аккаунта. Продолжить?'))return;state=data.state;state.profiles=Array.isArray(state.profiles)&&state.profiles.length?state.profiles:[{id:currentUser.id,name:'Я',target:DEFAULT_TARGET,plan:{},favorites:[]}];state.profiles[0].id=currentUser.id;state.activeProfileId=currentUser.id;saveLocal();markDirty();render();modal.classList.add('hidden');alert('Данные импортированы локально. Они синхронизируются при доступном Supabase.')}catch(e){alert('Не удалось импортировать файл: '+(e.message||e))}};i.click()}
function openProfiles(){const p=profile(),members=state.familyMembers||[];modalContent.innerHTML=`<span class="eyebrow">Аккаунт организатора</span><h2>${esc(p.name)}</h2><p class="note">${esc(currentUser?.email||'')}</p><div class="target-grid"><div class="account-stat"><b>${p.target.kcal}</b><span>ккал</span></div><div class="account-stat"><b>${p.target.protein}</b><span>белок</span></div><div class="account-stat"><b>${p.target.fat}</b><span>жиры</span></div><div class="account-stat"><b>${p.target.carbs}</b><span>углеводы</span></div></div><p class="tiny-note">${targetFormulaNote()}</p><button class="btn" onclick="editProfile()">Изменить мой профиль</button><section class="section"><div class="day-head"><h3>Семья</h3><button class="chip" onclick="editFamilyMember()">＋ добавить</button></div><p class="tiny-note">Членам семьи аккаунт не нужен. Они влияют только на порции, закупки и заготовки.</p>${members.map(m=>`<div class="family-row"><label><input type="checkbox" ${m.enabled!==false?'checked':''} onchange="toggleFamilyMember('${m.id}')"> <b>${esc(m.name)}</b><small>${m.target.kcal} ккал · Б ${m.target.protein} · Ж ${m.target.fat} · У ${m.target.carbs}</small></label><button class="chip" onclick="editFamilyMember('${m.id}')">изменить</button></div>`).join('')||'<div class="empty">Дополнительных участников пока нет.</div>'}</section><section class="section"><h3>Синхронизация и резервная копия</h3><p class="tiny-note">Локальные данные работают без сети. Supabase используется для аккаунта и облачной копии.</p><div class="week-actions"><button class="btn" onclick="syncNow()">Синхронизировать сейчас</button><button class="btn secondary" onclick="exportData()">Экспорт JSON</button><button class="btn secondary" onclick="chooseImport()">Импорт JSON</button></div></section><button class="btn secondary" onclick="signOut()">Выйти</button>`;modal.classList.remove('hidden')}
function toggleFamilyMember(id){const m=state.familyMembers.find(x=>x.id===id);if(!m)return;m.enabled=!m.enabled;state.shopping={};state.cookingDone={};save();openProfiles()}
function editFamilyMember(id=''){const m=id?state.familyMembers.find(x=>x.id===id):null,auto=!m||m.targetMode!=='custom',t=m?.target||macrosFromCalories(2200);modalContent.innerHTML=`<h2>${m?'Член семьи':'Добавить члена семьи'}</h2><label class="field">Имя<input id="fmName" value="${esc(m?.name||'')}"></label><label class="field">Калорийность<input id="fmKcal" type="number" min="800" max="6000" value="${t.kcal}" oninput="previewFamilyMacros()"></label><div class="mode-cards"><label class="mode-card"><input type="radio" name="familyMacroMode" value="auto" ${auto?'checked':''} onchange="toggleFamilyMacroMode()"><span><b>Авто 30 / 30 / 40</b><small>30% белки, 30% жиры, 40% углеводы</small></span></label><label class="mode-card"><input type="radio" name="familyMacroMode" value="custom" ${!auto?'checked':''} onchange="toggleFamilyMacroMode()"><span><b>Свои БЖУ</b><small>Задать граммы вручную</small></span></label></div><div class="target-grid"><label class="field">Белок, г<input id="fmProtein" type="number" value="${t.protein}"></label><label class="field">Жиры, г<input id="fmFat" type="number" value="${t.fat}"></label><label class="field">Углеводы, г<input id="fmCarbs" type="number" value="${t.carbs}"></label></div><p id="familyMacroFormula" class="tiny-note"></p><div class="row"><button class="btn" onclick="saveFamilyMember('${id}')">Сохранить</button>${m?`<button class="btn secondary" onclick="deleteFamilyMember('${id}')">Удалить</button>`:''}</div>`;toggleFamilyMacroMode()}
function selectedFamilyMacroMode(){return document.querySelector('input[name="familyMacroMode"]:checked')?.value||'auto'}
function previewFamilyMacros(){if(selectedFamilyMacroMode()!=='auto')return;const k=Number(document.querySelector('#fmKcal')?.value)||2200,m=macrosFromCalories(k);document.querySelector('#fmProtein').value=m.protein;document.querySelector('#fmFat').value=m.fat;document.querySelector('#fmCarbs').value=m.carbs;const n=document.querySelector('#familyMacroFormula');if(n)n.textContent=`${k} ккал → Б ${m.protein} г · Ж ${m.fat} г · У ${m.carbs} г по формуле 30/30/40.`}
function toggleFamilyMacroMode(){const auto=selectedFamilyMacroMode()==='auto';['fmProtein','fmFat','fmCarbs'].forEach(id=>{const e=document.querySelector('#'+id);if(e)e.disabled=auto});if(auto)previewFamilyMacros();else{const n=document.querySelector('#familyMacroFormula');if(n)n.textContent='Пользовательские БЖУ для этого участника.'}}
function saveFamilyMember(id=''){const name=document.querySelector('#fmName').value.trim()||'Член семьи',kcal=+document.querySelector('#fmKcal').value||2200,mode=selectedFamilyMacroMode(),t=mode==='auto'?macrosFromCalories(kcal):{kcal,protein:+document.querySelector('#fmProtein').value||0,fat:+document.querySelector('#fmFat').value||0,carbs:+document.querySelector('#fmCarbs').value||0};if(id){const m=state.familyMembers.find(x=>x.id===id);Object.assign(m,{name,target:t,targetMode:mode})}else state.familyMembers.push({id:'fm_'+Date.now().toString(36),name,target:t,targetMode:mode,enabled:true});state.shopping={};state.cookingDone={};save();openProfiles()}
function deleteFamilyMember(id){state.familyMembers=state.familyMembers.filter(x=>x.id!==id);state.shopping={};state.cookingDone={};save();openProfiles()}
function editProfile(){const p=profile(),auto=state.targetMode!=='custom';modalContent.innerHTML=`<h2>Профиль и цели</h2><label class="field">Имя<input id="pfName" value="${esc(p.name)}"></label><label class="field">Калорийность<input id="pfKcal" type="number" min="800" max="6000" value="${p.target.kcal}" oninput="previewAutoMacros()"></label><div class="mode-cards"><label class="mode-card"><input type="radio" name="macroMode" value="auto" ${auto?'checked':''} onchange="toggleMacroMode()"><span><b>Авто 30 / 30 / 40</b><small>30% калорий — белки, 30% — жиры, 40% — углеводы</small></span></label><label class="mode-card"><input type="radio" name="macroMode" value="custom" ${!auto?'checked':''} onchange="toggleMacroMode()"><span><b>Свои БЖУ</b><small>Задать граммы вручную</small></span></label></div><div class="target-grid"><label class="field">Белок, г<input id="pfProtein" type="number" value="${p.target.protein}"></label><label class="field">Жиры, г<input id="pfFat" type="number" value="${p.target.fat}"></label><label class="field">Углеводы, г<input id="pfCarbs" type="number" value="${p.target.carbs}"></label></div><p id="macroFormula" class="tiny-note"></p><button class="btn" onclick="saveProfile()">Сохранить</button>`;toggleMacroMode()}
function selectedMacroMode(){return document.querySelector('input[name="macroMode"]:checked')?.value||'auto'}
function previewAutoMacros(){if(selectedMacroMode()!=='auto')return;const k=Number(document.querySelector('#pfKcal')?.value)||1750,m=macrosFromCalories(k);document.querySelector('#pfProtein').value=m.protein;document.querySelector('#pfFat').value=m.fat;document.querySelector('#pfCarbs').value=m.carbs;const n=document.querySelector('#macroFormula');if(n)n.textContent=`${k} ккал → Б ${m.protein} г · Ж ${m.fat} г · У ${m.carbs} г по формуле 30/30/40.`}
function toggleMacroMode(){const auto=selectedMacroMode()==='auto';['pfProtein','pfFat','pfCarbs'].forEach(id=>{const e=document.querySelector('#'+id);if(e)e.disabled=auto});if(auto)previewAutoMacros();else{const n=document.querySelector('#macroFormula');if(n)n.textContent='Пользовательский режим: значения БЖУ задаются вручную.'}}
function saveProfile(){const p=profile(),kcal=+document.querySelector('#pfKcal').value||1750,mode=selectedMacroMode();p.name=document.querySelector('#pfName').value.trim()||'Я';p.target=mode==='auto'?macrosFromCalories(kcal):{kcal,protein:+document.querySelector('#pfProtein').value||0,fat:+document.querySelector('#pfFat').value||0,carbs:+document.querySelector('#pfCarbs').value||0};state.targetMode=mode;state.cookingDone={};state.shopping={};save();modal.classList.add('hidden');updateProfileButton();render()}
function updateProfileButton(){const b=document.querySelector('#profileBtn');if(b&&profile())b.textContent=(profile().name||'Я').slice(0,2).toUpperCase()}

function render(){if(!state||!currentUser)return;state.customRecipes??=[];state.mealSkips??={};state.cookingDone??={};state.shopping??={};state.weekPreferences??=defaultWeekPreferences();document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view));({today:renderToday,library:renderLibrary,week:renderWeek,cooking:renderCooking,shopping:renderShopping}[state.view]||renderToday)();updateProfileButton()}
document.querySelectorAll('.bottom-nav button').forEach(b=>b.onclick=()=>{if(!state)return;state.view=b.dataset.view;save();render()});
document.querySelector('#closeModal').onclick=()=>modal.classList.add('hidden');modal.onclick=e=>{if(e.target===modal)modal.classList.add('hidden')};document.querySelector('#profileBtn').onclick=openProfiles;
let deferredPrompt;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;document.querySelector('#installBtn').classList.remove('hidden')});document.querySelector('#installBtn').onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null}};
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js');

async function bootSession(session){
  if(!session?.user)return;
  const cloudUser=session.user;storeOfflineUser(cloudUser);
  const switching=currentUser?.id&&currentUser.id!==cloudUser.id;
  currentUser=cloudUser;setSignedInUI(true);suppressSync=true;
  const cached=switching?null:(state||await loadCachedState(currentUser.id));
  if(cached){state=cached;render();setSyncStatus(pendingChanges()?`Есть изменения · ${pendingChanges()}`:'Локальные данные загружены')}
  if(pendingChanges()&&state){suppressSync=false;await syncAllToCloud({force:true});render();return}
  const info=await loadCloudState(currentUser);suppressSync=false;render();
  if(info.remoteEmpty&&!info.offline)offerLegacyMigration();
}
function attachAuthListener(){if(authListenerAttached||!sb)return;authListenerAttached=true;sb.auth.onAuthStateChange(async(event,session)=>{if(event==='PASSWORD_RECOVERY'){currentUser=session?.user||currentUser;if(currentUser)storeOfflineUser(currentUser);showRecovery();return}if(event==='SIGNED_IN'&&session){await bootSession(session)}else if(event==='SIGNED_OUT'&&!readOfflineUser()){currentUser=null;state=null;renderAuth('login')}})}
async function bootOfflineFirst(){
  const remembered=readOfflineUser();
  if(remembered){currentUser=remembered;state=await loadCachedState(remembered.id)||emptyState(remembered.id,remembered.user_metadata?.name||remembered.email?.split('@')[0]||'Я');setSignedInUI(true);suppressSync=false;render();setSyncStatus(offlineStatusText())}
  else renderAuth('login');
  const client=await ensureCloudClient();if(!client){if(remembered)setSyncStatus(offlineStatusText());return}
  try{const {data:{session}}=await client.auth.getSession();if(session?.user)await bootSession(session);else if(!remembered)renderAuth('login')}catch(e){console.warn('Cloud session unavailable',e);if(remembered)setSyncStatus(offlineStatusText())}
}
window.addEventListener('online',()=>{if(currentUser){setSyncStatus('Сеть появилась · синхронизация…');syncAllToCloud({force:true})}});
window.addEventListener('offline',()=>{if(currentUser)setSyncStatus(offlineStatusText())});
bootOfflineFirst();
