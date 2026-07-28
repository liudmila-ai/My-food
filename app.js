const app=document.querySelector('#app'),modal=document.querySelector('#modal'),modalContent=document.querySelector('#modalContent');
const DAYS=['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
const SLOTS=[['breakfast','Завтрак'],['lunch','Обед'],['snack','Перекус'],['dinner','Ужин']];
const DEFAULT_TARGET={kcal:1750,protein:130,fat:60,carbs:165};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sb=window.supabase.createClient(window.SUPABASE_CONFIG.url,window.SUPABASE_CONFIG.publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
let currentUser=null;
let state=null;
let cloudTimer=null;
let syncing=false;
let syncAgain=false;
let suppressSync=true;

function emptyState(userId,name='Я',target=DEFAULT_TARGET){const t={kcal:target?.kcal??DEFAULT_TARGET.kcal,protein:target?.protein??DEFAULT_TARGET.protein,fat:target?.fat??DEFAULT_TARGET.fat,carbs:target?.carbs??DEFAULT_TARGET.carbs};return {recipeIngredients:{},shopping:{},cookingDone:{},view:'today',combineHousehold:false,profiles:[{id:userId,name:name||'Я',target:t,plan:{},favorites:[],weight:'',note:''}],activeProfileId:userId,householdProfileIds:[userId]}}
const profile=()=>state?.profiles?.[0];
const participants=()=>profile()?[profile()]:[];
const target=()=>profile()?.target||DEFAULT_TARGET;
function cacheKey(){return currentUser?`mealState:${currentUser.id}`:null}
function saveLocal(){if(cacheKey()&&state)localStorage.setItem(cacheKey(),JSON.stringify(state))}
function save(){saveLocal();if(!suppressSync)scheduleCloudSync()}

function mondayOf(date=new Date()){const d=new Date(date);d.setHours(12,0,0,0);const day=(d.getDay()+6)%7;d.setDate(d.getDate()-day);return d}
function addDays(d,n){const x=new Date(d);x.setDate(x.getDate()+n);return x}
function isoLocal(d){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function weekDates(){const m=mondayOf();return DAYS.map((_,i)=>isoLocal(addDays(m,i)))}
function dayByDate(date){const i=weekDates().indexOf(date);return i>=0?DAYS[i]:null}

function scheduleCloudSync(){clearTimeout(cloudTimer);cloudTimer=setTimeout(syncAllToCloud,650)}
async function syncAllToCloud(){
  if(!currentUser||!state||suppressSync)return;
  if(syncing){syncAgain=true;return}
  syncing=true;
  try{
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

    error=(await sb.from('user_settings').upsert({user_id:uid,settings:{view:state.view}},{onConflict:'user_id'})).error;if(error)throw error;
    setSyncStatus('Синхронизировано');
  }catch(e){console.error('Supabase sync failed',e);setSyncStatus('Есть несохранённые изменения')}
  finally{syncing=false;if(syncAgain){syncAgain=false;scheduleCloudSync()}}
}

async function loadCloudState(user){
  const uid=user.id,dates=weekDates();
  const cached=JSON.parse(localStorage.getItem(`mealState:${uid}`)||'null');
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
    state=st;saveLocal();setSyncStatus('Синхронизировано');
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

function setSyncStatus(text){const el=document.querySelector('#syncStatus');if(el)el.textContent=text}
function setSignedInUI(on){document.body.classList.toggle('auth-mode',!on);document.querySelector('.bottom-nav').classList.toggle('hidden',!on);document.querySelector('#profileBtn').classList.toggle('hidden',!on)}
function appRedirectUrl(){return location.origin+location.pathname}
function authErrorMessage(e){const m=e?.message||String(e||'Ошибка');if(/Invalid login credentials/i.test(m))return'Неверный email или пароль.';if(/Email not confirmed/i.test(m))return'Сначала подтвердите email по ссылке из письма.';if(/Password should be/i.test(m))return'Пароль слишком короткий. Используйте минимум 6 символов.';return m}

function renderAuth(mode='login',message=''){
  setSignedInUI(false);
  const signup=mode==='signup';
  app.innerHTML=`<section class="auth-wrap"><div class="auth-card"><span class="eyebrow">Моя еда · v7</span><h2>${signup?'Создать аккаунт':'Войти'}</h2>${message?`<div class="auth-message">${esc(message)}</div>`:''}${signup?`<label class="field">Имя<input id="authName" autocomplete="name" placeholder="Как вас называть"></label>`:''}<label class="field">Email<input id="authEmail" type="email" autocomplete="email" placeholder="name@example.com"></label><label class="field">Пароль<input id="authPassword" type="password" autocomplete="${signup?'new-password':'current-password'}" placeholder="Минимум 6 символов"></label>${signup?`<label class="field">Повторите пароль<input id="authPassword2" type="password" autocomplete="new-password"></label>`:''}<button class="btn auth-primary" onclick="${signup?'signUp()':'signIn()'}">${signup?'Создать аккаунт':'Войти'}</button><button class="auth-link" onclick="renderAuth('${signup?'login':'signup'}')">${signup?'Уже есть аккаунт':'Создать аккаунт'}</button>${!signup?`<button class="auth-link" onclick="resetPassword()">Забыли пароль?</button>`:''}</div></section>`;
}
async function signUp(){const name=document.querySelector('#authName').value.trim(),email=document.querySelector('#authEmail').value.trim(),password=document.querySelector('#authPassword').value,p2=document.querySelector('#authPassword2').value;if(!email||!password)return renderAuth('signup','Заполните email и пароль.');if(password!==p2)return renderAuth('signup','Пароли не совпадают.');const {data,error}=await sb.auth.signUp({email,password,options:{data:{name:name||'Я'},emailRedirectTo:appRedirectUrl()}});if(error)return renderAuth('signup',authErrorMessage(error));if(!data.session)return renderAuth('login','Аккаунт создан. Проверьте почту и подтвердите email, затем войдите.');}
async function signIn(){const email=document.querySelector('#authEmail').value.trim(),password=document.querySelector('#authPassword').value;const {error}=await sb.auth.signInWithPassword({email,password});if(error)renderAuth('login',authErrorMessage(error))}
async function resetPassword(){const email=document.querySelector('#authEmail')?.value.trim()||prompt('Email для восстановления пароля:');if(!email)return;const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:appRedirectUrl()});renderAuth('login',error?authErrorMessage(error):'Письмо для восстановления пароля отправлено.')}
function showRecovery(){modalContent.innerHTML=`<h2>Новый пароль</h2><label class="field">Новый пароль<input id="newPassword" type="password" autocomplete="new-password"></label><button class="btn" onclick="updatePassword()">Сохранить пароль</button>`;modal.classList.remove('hidden')}
async function updatePassword(){const password=document.querySelector('#newPassword').value;const {error}=await sb.auth.updateUser({password});if(error){alert(authErrorMessage(error));return}modal.classList.add('hidden');alert('Пароль изменён.')}
async function signOut(){await syncAllToCloud();await sb.auth.signOut();currentUser=null;state=null;renderAuth('login','Вы вышли из аккаунта.')}

const dish=id=>DISHES.find(d=>d.id===id);
const totals=ids=>ids.map(dish).filter(Boolean).reduce((a,d)=>({kcal:a.kcal+d.kcal,protein:a.protein+d.protein,fat:a.fat+d.fat,carbs:a.carbs+d.carbs}),{kcal:0,protein:0,fat:0,carbs:0});
const currentDay=()=>DAYS[(new Date().getDay()+6)%7];

function macro(t,label,key){return `<div class="macro"><b>${Math.round(t[key])}</b><span>${label}</span></div>`}
function recipeIngredients(id){return state.recipeIngredients[id]||RECIPE_DETAILS[id]?.ingredients||[]}
function ingredientText(x){return `${esc(x.name)} — ${x.qty} ${x.unit||'г'}`}

function mealRow(day,key,label){const p=profile(),d=dish((p.plan[day]||{})[key]);if(!d)return `<div class="slot empty-slot" onclick="chooseMeal('${day}','${key}')"><span>${label}: <b>выбрать блюдо</b></span><button>＋</button></div>`;return `<div class="slot meal-slot"><button class="meal-open" onclick="openDish('${d.id}')"><span><small>${label}</small><b>${esc(d.name)}</b><em>${d.kcal} ккал · Б ${d.protein}</em></span></button><button class="replace-btn" onclick="chooseMeal('${day}','${key}')">заменить</button></div>`}
function renderToday(){const p=profile(),day=currentDay(),pp=p.plan[day]||{},t=totals(SLOTS.map(([k])=>pp[k]).filter(Boolean)),tar=target();app.innerHTML=`<section class="hero"><span class="eyebrow">${esc(p.name)} · ${day}</span><h2>${t.kcal} / ${tar.kcal} ккал</h2><div class="macro-grid">${macro(t,'ккал','kcal')}${macro(t,'белок','protein')}${macro(t,'жиры','fat')}${macro(t,'углеводы','carbs')}</div><div class="progress"><i style="width:${Math.min(100,t.kcal/tar.kcal*100)}%"></i></div></section><section class="section"><h2>Сегодня</h2>${SLOTS.map(([k,l])=>mealRow(day,k,l)).join('')}</section><section class="section"><button class="btn" onclick="randomizeDay('${day}')">Собрать день автоматически</button></section>`}
function cardHTML(d){return `<div class="card dish-card" onclick="openDish('${d.id}')"><div><div class="dish-id">${d.id} · ${d.category}</div><div class="dish-title">${esc(d.name)}</div><div class="meta">${d.minutes} мин · Б ${d.protein} г · ${d.tags.slice(0,3).join(' · ')}</div></div><div><div class="kcal">${d.kcal}</div><div class="meta">ккал</div></div></div>`}
function renderLibrary(){const p=profile();app.innerHTML=`<input id="search" class="search" placeholder="Найти блюдо или ингредиент"><div class="chips" id="cats">${['Все','Завтрак','Основное','Перекус','Аварийное','❤️'].map((x,i)=>`<button class="chip ${i===0?'active':''}" data-cat="${x}">${x}</button>`).join('')}</div><div id="dishList"></div>`;let cat='Все';const draw=()=>{const q=document.querySelector('#search').value.toLowerCase();const arr=DISHES.filter(d=>(cat==='Все'||d.category===cat||(cat==='❤️'&&p.favorites.includes(d.id)))&&(d.name+' '+d.ingredients.join(' ')+' '+d.tags.join(' ')).toLowerCase().includes(q));document.querySelector('#dishList').innerHTML=arr.map(cardHTML).join('')||'<div class="empty">Ничего не найдено.</div>'};document.querySelector('#search').oninput=draw;document.querySelectorAll('[data-cat]').forEach(b=>b.onclick=()=>{cat=b.dataset.cat;document.querySelectorAll('[data-cat]').forEach(x=>x.classList.toggle('active',x===b));draw()});draw()}
function openDish(id){const d=dish(id),r=RECIPE_DETAILS[id],ings=recipeIngredients(id),p=profile();modalContent.innerHTML=`<span class="eyebrow">${d.id} · ${d.category}</span><h2 style="padding-right:44px">${esc(d.name)}</h2><div class="macro-grid">${[['ккал',d.kcal],['Б',d.protein],['Ж',d.fat],['У',d.carbs]].map(x=>`<div class="macro"><b>${x[1]}</b><span>${x[0]}</span></div>`).join('')}</div><section class="section"><div class="day-head"><h3>Ингредиенты · 1 порция</h3><button class="chip" onclick="editIngredients('${id}')">✎ изменить</button></div><ul class="ingredient-list">${ings.map(x=>`<li>${ingredientText(x)}</li>`).join('')}</ul><p class="tiny-note">Крупы/паста/картофель указаны в готовом виде; мясо и рыба преимущественно в сыром.</p></section><section class="section"><h3>Приготовление</h3><p class="note">${esc(r.steps)}</p></section><section class="section"><h3>Хранение и заготовка</h3><p class="note">${esc(r.storage||'Ориентируйтесь на самый скоропортящийся компонент.')}</p></section>${r.replacements?`<section class="section"><h3>Замены</h3><p class="note">${esc(r.replacements)}</p></section>`:''}<div class="row"><button class="btn" onclick="toggleFavorite('${id}')">${p.favorites.includes(id)?'♥ В любимых':'♡ В любимое'}</button><button class="btn secondary" onclick="addToToday('${id}')">Добавить сегодня</button></div>`;modal.classList.remove('hidden')}
function editIngredients(id){window._editingIngredients=recipeIngredients(id).map(x=>({...x}));const draw=()=>{modalContent.innerHTML=`<h2>Граммовки · ${esc(dish(id).name)}</h2><p class="note">Количество на 1 порцию. Изменения сохраняются только в вашем аккаунте.</p><div>${window._editingIngredients.map((x,i)=>`<div class="ingredient-edit-row"><input value="${esc(x.name)}" oninput="_editingIngredients[${i}].name=this.value"><input type="number" min="0" step="1" value="${x.qty}" oninput="_editingIngredients[${i}].qty=Number(this.value)"><select onchange="_editingIngredients[${i}].unit=this.value">${['г','мл','шт','ст.л.','ч.л.','банка','уп.'].map(u=>`<option ${x.unit===u?'selected':''}>${u}</option>`).join('')}</select><button class="remove-ing" onclick="_editingIngredients.splice(${i},1);editIngredients('${id}')">×</button></div>`).join('')}</div><div class="week-actions"><button class="btn secondary" onclick="_editingIngredients.push({name:'',qty:0,unit:'г'});editIngredients('${id}')">＋ ингредиент</button><button class="btn" onclick="state.recipeIngredients['${id}']=_editingIngredients.filter(x=>x.name.trim());save();openDish('${id}')">Сохранить</button></div>`};draw()}
function toggleFavorite(id){const p=profile();p.favorites=p.favorites.includes(id)?p.favorites.filter(x=>x!==id):[...p.favorites,id];save();openDish(id)}
function addToToday(id){const p=profile(),d=dish(id),key=d.category==='Завтрак'?'breakfast':d.category==='Перекус'?'snack':'dinner';p.plan[currentDay()]??={};p.plan[currentDay()][key]=id;save();modal.classList.add('hidden');render()}

function renderWeek(){const p=profile(),ts=DAYS.map(day=>totals(SLOTS.map(([k])=>(p.plan[day]||{})[k]).filter(Boolean))),filled=ts.filter(t=>t.kcal>0),avg=filled.length?Math.round(filled.reduce((a,t)=>a+t.kcal,0)/filled.length):0;app.innerHTML=`<section><h2>Неделя · ${esc(p.name)}</h2><div class="week-actions"><button class="btn" onclick="randomizeWeek()">Составить экономную неделю</button><button class="btn secondary" onclick="clearWeek()">Очистить</button></div>${filled.length?`<div class="week-summary">Среднее: <b>${avg} ккал/день</b> · ${filled.length}/7 дней</div>`:''}<p class="note">Автоплан ограничивает число баз: обычно 2 белка + 2 гарнира на неделю, а разнообразие создают соусы и сборка.</p>${DAYS.map(day=>{const pp=p.plan[day]||{},t=totals(SLOTS.map(([k])=>pp[k]).filter(Boolean));return `<div class="day"><div class="day-head"><b>${day}</b><span class="meta">${t.kcal} ккал · Б ${t.protein}</span></div><div class="slots">${SLOTS.map(([k,l])=>mealRow(day,k,l)).join('')}</div></div>`}).join('')}</section>`}
function clearWeek(){profile().plan={};state.cookingDone={};save();render()}
function chooseMeal(day,key){const desired=key==='breakfast'?'Завтрак':key==='snack'?'Перекус':'Основное';const arr=DISHES.filter(d=>d.category===desired||(key!=='breakfast'&&key!=='snack'&&d.category==='Аварийное'));const draw=q=>arr.filter(d=>(d.name+' '+d.ingredients.join(' ')).toLowerCase().includes(q.toLowerCase())).map(d=>`<div class="card dish-card picker-row"><button class="picker-info" onclick="openDish('${d.id}')"><div class="dish-title">${esc(d.name)}</div><div class="meta">${d.kcal} ккал · Б ${d.protein}</div></button><button class="pick-btn" onclick="setMeal('${day}','${key}','${d.id}')">выбрать</button></div>`).join('');modalContent.innerHTML=`<h2>Выбрать: ${SLOTS.find(s=>s[0]===key)[1]}</h2><input class="search" id="pickerSearch" placeholder="Поиск"><div id="pickerList">${draw('')}</div>`;modal.classList.remove('hidden');document.querySelector('#pickerSearch').oninput=e=>document.querySelector('#pickerList').innerHTML=draw(e.target.value)}
function setMeal(day,key,id){const p=profile();p.plan[day]??={};p.plan[day][key]=id;state.cookingDone={};save();modal.classList.add('hidden');render()}
function randomizeDay(day){const p=profile(),tar=target(),b=DISHES.filter(d=>d.category==='Завтрак'),m=DISHES.filter(d=>d.category==='Основное'),sn=DISHES.filter(d=>d.category==='Перекус');let best,bestScore=1e9;for(let i=0;i<700;i++){const pp={breakfast:b[Math.random()*b.length|0].id,lunch:m[Math.random()*m.length|0].id,snack:sn[Math.random()*sn.length|0].id,dinner:m[Math.random()*m.length|0].id},t=totals(Object.values(pp)),score=Math.abs(t.kcal-tar.kcal)*1.2+Math.abs(t.protein-tar.protein)*4+(pp.lunch===pp.dinner?100:0);if(score<bestScore){bestScore=score;best=pp}}p.plan[day]=best;state.cookingDone={};save();render()}

const proteinFamily=d=>{const s=(d.tags.join(' ')+' '+d.ingredients.join(' ')).toLowerCase();if(s.includes('куриц'))return'Курица';if(s.includes('индей'))return'Индейка';if(s.includes('говя'))return'Говядина';if(s.includes('лосос'))return'Лосось';if(s.includes('тунец'))return'Тунец';if(s.includes('рыба'))return'Белая рыба';if(s.includes('кревет'))return'Креветки';if(s.includes('фалафель')||s.includes('чечев'))return'Бобовые';return'Другое'};
const carbFamily=d=>{const s=d.ingredients.join(' ').toLowerCase();if(s.includes('рис'))return'Рис';if(s.includes('картоф'))return'Картофель';if(s.includes('паста')||s.includes('лазан'))return'Паста';if(s.includes('булгур'))return'Булгур';if(s.includes('удон'))return'Удон';if(s.includes('пита')||s.includes('тортиль'))return'Лепёшки';return'Другое'};
const WEEK_TEMPLATES=[
 {proteins:['Курица','Индейка'],carbs:['Рис','Картофель','Паста'],label:'курица + индейка'},
 {proteins:['Курица','Говядина'],carbs:['Рис','Картофель','Паста'],label:'курица + говядина'},
 {proteins:['Курица','Лосось'],carbs:['Рис','Картофель','Булгур'],label:'курица + рыба'},
 {proteins:['Говядина','Индейка'],carbs:['Рис','Картофель','Паста'],label:'говядина + индейка'}
];
function randomizeWeek(){const p=profile(),tar=target(),b=DISHES.filter(d=>d.category==='Завтрак'),sn=DISHES.filter(d=>d.category==='Перекус'),allM=DISHES.filter(d=>d.category==='Основное');const tpl=WEEK_TEMPLATES[Math.random()*WEEK_TEMPLATES.length|0];let mains=allM.filter(d=>tpl.proteins.includes(proteinFamily(d))&&tpl.carbs.includes(carbFamily(d)));if(mains.length<6)mains=allM.filter(d=>tpl.proteins.includes(proteinFamily(d)));
 const breakfastPool=[...b].sort(()=>Math.random()-.5).slice(0,4), snackPool=[...sn].sort(()=>Math.random()-.5).slice(0,4);const used={};
 DAYS.forEach((day,di)=>{let best,bestScore=1e9;for(let i=0;i<800;i++){const lunch=mains[Math.random()*mains.length|0],dinner=mains[Math.random()*mains.length|0],pp={breakfast:breakfastPool[di%breakfastPool.length].id,lunch:lunch.id,snack:snackPool[di%snackPool.length].id,dinner:dinner.id},t=totals(Object.values(pp));const repeat=(used[lunch.id]||0)*18+(used[dinner.id]||0)*18;const uniqueProtein=(proteinFamily(lunch)!==proteinFamily(dinner)?10:0);const score=Math.abs(t.kcal-tar.kcal)*1.2+Math.abs(t.protein-tar.protein)*4+repeat+(lunch.id===dinner.id?80:0)+uniqueProtein;if(score<bestScore){bestScore=score;best=pp}}p.plan[day]=best;[best.lunch,best.dinner].forEach(id=>used[id]=(used[id]||0)+1)});state.cookingDone={};save();render()}

function selectedPlans(){return participants().flatMap(p=>DAYS.flatMap(day=>Object.values(p.plan[day]||{}).map(id=>({profile:p,day,id})).filter(x=>x.id)))}
function shoppingItems(){const exact=new Map();selectedPlans().forEach(({id})=>recipeIngredients(id).forEach(x=>{const key=`${x.name}|${x.unit||'г'}`;exact.set(key,(exact.get(key)||0)+Number(x.qty||0))}));return [...exact.entries()].map(([key,qty])=>{const [name,unit]=key.split('|');return{name,unit,qty}}).filter(x=>x.qty>0).sort((a,b)=>a.name.localeCompare(b.name,'ru'))}
function householdToggleHTML(){return ''}
function renderShopping(){const items=shoppingItems();app.innerHTML=`<section><h2>Покупки</h2>${householdToggleHTML()}<p class="note">Личный список текущего аккаунта.</p>${items.map(x=>{const key=`${x.name}|${x.unit}`;return `<label class="shop-row ${state.shopping[key]?'done':''}"><input type="checkbox" ${state.shopping[key]?'checked':''} onchange="toggleShop('${key.replace(/'/g,"\\'")}')"><span>${esc(x.name)} <b>${Math.round(x.qty*10)/10} ${x.unit}</b></span></label>`}).join('')||'<div class="empty">Сначала составьте меню.</div>'}</section>`}
function toggleShop(k){state.shopping[k]=!state.shopping[k];save();renderShopping()}

function normName(s){return s.toLowerCase().replace(/ё/g,'е')}
function prepGroup(name){const s=normName(name);if(/курин|курица/.test(s))return['protein','Курица'];if(/индей/.test(s))return['protein','Индейка'];if(/говя/.test(s))return['protein','Говядина'];if(/лосос/.test(s))return['fresh','Лосось'];if(/белая рыба/.test(s))return['fresh','Белая рыба'];if(/кревет/.test(s))return['fresh','Креветки'];if(/рис/.test(s))return['carb','Рис'];if(/картоф/.test(s))return['carb','Картофель'];if(/паста|лазан/.test(s))return['carb','Паста'];if(/булгур/.test(s))return['carb','Булгур'];if(/удон/.test(s))return['carb','Удон'];if(/брокколи|морковь|перец|овощ|кабач|баклаж|шпинат/.test(s))return['veg','Овощи'];return null}
function aggregatePrep(){const map=new Map();selectedPlans().forEach(({id})=>recipeIngredients(id).forEach(x=>{if((x.unit||'г')!=='г')return;const g=prepGroup(x.name);if(!g)return;const [type,label]=g,key=type+'|'+label;const z=map.get(key)||{type,label,qty:0,examples:new Set()};z.qty+=Number(x.qty||0);z.examples.add(dish(id)?.name||id);map.set(key,z)}));return [...map.values()]}
function cookingPlan(){const all=selectedPlans();if(!all.length)return[];const prep=aggregatePrep(),groups=[];const sunday=prep.filter(x=>x.type==='protein'||x.type==='carb'||x.type==='veg');const fresh=prep.filter(x=>x.type==='fresh');if(sunday.length)groups.push({title:'Воскресенье · базовая готовка',time:'около 90–120 мин',items:sunday.map(x=>({key:'base-'+x.label,label:`${x.label} · ${Math.round(x.qty)} г`,text:x.type==='protein'?`Приготовить нейтральной базой и разделить на порции. Вкус меняют соусы и сборка (${[...x.examples].slice(0,3).join(', ')}).`:x.type==='carb'?`Приготовить одной партией. Вес указан готового продукта; разложить по контейнерам.`:`Запечь/подготовить общую овощную базу, часть оставить свежей.`}))});if(fresh.length)groups.push({title:'Среда · свежие белки',time:'около 25–40 мин',items:fresh.map(x=>({key:'fresh-'+x.label,label:`${x.label} · ${Math.round(x.qty)} г`,text:'Готовить ближе к употреблению; при необходимости разделить на 2 небольшие партии.'}))});
 const daily=DAYS.map(day=>{const meals=participants().flatMap(p=>Object.values(p.plan[day]||{}).map(id=>({p,id,d:dish(id),r:RECIPE_DETAILS[id]})).filter(x=>x.id));const freshMeals=meals.filter(x=>x.r?.prepType==='fresh'||x.r?.prepType==='nocook'||x.r?.prepType==='daybefore');if(!freshMeals.length)return null;return {key:'day-'+day,label:day,text:freshMeals.map(x=>`${x.p.name}: ${x.d.name}`).join(' · ')}}).filter(Boolean);if(daily.length)groups.push({title:'По дням · только сборка и свежее',time:'5–20 мин',items:daily});return groups}
function renderCooking(){const groups=cookingPlan();app.innerHTML=`<section><h2>Готовка</h2>${householdToggleHTML()}<p class="note">Сначала готовятся общие базы крупными партиями. Разные блюда получаются за счёт соусов, свежих добавок и сборки, а не семи отдельных кастрюль.</p>${groups.length?groups.map(g=>`<div class="cook-block"><div class="day-head"><h3>${g.title}</h3><span class="meta">${g.time}</span></div>${g.items.map(x=>`<label class="cook-task ${state.cookingDone[x.key]?'done':''}"><input type="checkbox" ${state.cookingDone[x.key]?'checked':''} onchange="toggleCook('${x.key.replace(/'/g,"\\'")}')"><span><b>${esc(x.label)}</b><small>${esc(x.text)}</small></span></label>`).join('')}</div>`).join(''):'<div class="empty">Сначала составьте меню на неделю.</div>'}</section>`}
function toggleCook(k){state.cookingDone[k]=!state.cookingDone[k];save();renderCooking()}

function openProfiles(){const p=profile();modalContent.innerHTML=`<span class="eyebrow">Аккаунт</span><h2>${esc(p.name)}</h2><p class="note">${esc(currentUser?.email||'')}</p><div class="target-grid"><div class="account-stat"><b>${p.target.kcal}</b><span>ккал</span></div><div class="account-stat"><b>${p.target.protein}</b><span>белок</span></div><div class="account-stat"><b>${p.target.fat}</b><span>жиры</span></div><div class="account-stat"><b>${p.target.carbs}</b><span>углеводы</span></div></div><button class="btn" onclick="editProfile()">Изменить профиль и цели</button><button class="btn secondary" style="margin-top:10px" onclick="signOut()">Выйти</button><p class="tiny-note">Меню, избранное, граммовки, покупки и готовка синхронизируются только с этим аккаунтом. Другие пользователи их не видят.</p>`;modal.classList.remove('hidden')}
function editProfile(){const p=profile();modalContent.innerHTML=`<h2>Профиль</h2><label class="field">Имя<input id="pfName" value="${esc(p.name)}"></label><div class="target-grid"><label class="field">ккал<input id="pfKcal" type="number" value="${p.target.kcal}"></label><label class="field">Белок<input id="pfProtein" type="number" value="${p.target.protein}"></label><label class="field">Жиры<input id="pfFat" type="number" value="${p.target.fat}"></label><label class="field">Углеводы<input id="pfCarbs" type="number" value="${p.target.carbs}"></label></div><button class="btn" onclick="saveProfile()">Сохранить</button>`}
function saveProfile(){const p=profile();p.name=document.querySelector('#pfName').value.trim()||'Я';p.target={kcal:+document.querySelector('#pfKcal').value||1750,protein:+document.querySelector('#pfProtein').value||130,fat:+document.querySelector('#pfFat').value||60,carbs:+document.querySelector('#pfCarbs').value||165};save();modal.classList.add('hidden');updateProfileButton();render()}
function updateProfileButton(){const b=document.querySelector('#profileBtn');if(b&&profile())b.textContent=(profile().name||'Я').slice(0,2).toUpperCase()}

function render(){if(!state||!currentUser)return;document.querySelectorAll('.bottom-nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view));({today:renderToday,library:renderLibrary,week:renderWeek,cooking:renderCooking,shopping:renderShopping}[state.view]||renderToday)();updateProfileButton()}
document.querySelectorAll('.bottom-nav button').forEach(b=>b.onclick=()=>{if(!state)return;state.view=b.dataset.view;save();render()});
document.querySelector('#closeModal').onclick=()=>modal.classList.add('hidden');modal.onclick=e=>{if(e.target===modal)modal.classList.add('hidden')};document.querySelector('#profileBtn').onclick=openProfiles;
let deferredPrompt;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredPrompt=e;document.querySelector('#installBtn').classList.remove('hidden')});document.querySelector('#installBtn').onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null}};
if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js');

async function bootSession(session){
  if(!session?.user){currentUser=null;state=null;renderAuth('login');return}
  currentUser=session.user;setSignedInUI(true);suppressSync=true;
  const info=await loadCloudState(currentUser);suppressSync=false;render();
  if(info.remoteEmpty&&!info.offline)offerLegacyMigration();
}
(async()=>{const {data:{session}}=await sb.auth.getSession();await bootSession(session)})();
sb.auth.onAuthStateChange(async(event,session)=>{if(event==='PASSWORD_RECOVERY'){currentUser=session?.user||currentUser;showRecovery();return}if(event==='SIGNED_IN'&&session){if(currentUser?.id!==session.user.id)await bootSession(session)}else if(event==='SIGNED_OUT'){currentUser=null;state=null;renderAuth('login')}});
