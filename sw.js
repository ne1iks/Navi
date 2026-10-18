self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{
    for(const c of l)if('focus' in c)return c.focus();
    return self.clients.openWindow('./');
  }));
});
/* для серверных push (FCM/Web Push), если вы подключите отправку с сервера */
self.addEventListener('push',e=>{
  let d={};try{d=e.data.json()}catch{}
  const n=d.notification||d;
  e.waitUntil(self.registration.showNotification(n.title||'Круг',{body:n.body||''}));
});
