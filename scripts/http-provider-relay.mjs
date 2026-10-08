import { connect, createServer } from 'node:net';

const [host,port] = process.argv.slice(2);
if (!host || !/^\d+$/.test(port) || !process.send) process.exit(1);
let available=true;
const sockets=new Set();
const server=createServer(client=>{
  sockets.add(client);
  client.on('close',()=>sockets.delete(client));
  client.on('error',()=>{});
  if (!available) return;
  const backend=connect(Number(port),host);
  sockets.add(backend);
  backend.on('close',()=>sockets.delete(backend));
  client.on('error',()=>backend.destroy());
  backend.on('error',()=>client.destroy());
  client.pipe(backend).pipe(client);
});
server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
process.on('message',command=>{
  if (command==='stall') {
    available=false;
    for (const socket of sockets) socket.destroy();
    process.send({state:'stalled'});
  } else if (command==='forward') {
    available=true;
    process.send({state:'forwarding'});
  } else if (command==='close') {
    for (const socket of sockets) socket.destroy();
    server.close(()=>process.exit(0));
  }
});
