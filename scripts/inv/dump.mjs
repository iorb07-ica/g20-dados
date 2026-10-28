// Investigação da rentabilidade (28/10/2026): copia os dados de investimento do admin (Carteira G20 e
// Minha Carteira) CIFRADOS com a chave pública ao lado. Só quem tem a chave privada (a sessão de
// investigação) consegue ler. Nada em claro vai para o repositório ou para o registro.
import fs from 'node:fs'; import crypto from 'node:crypto'; import zlib from 'node:zlib'; import admin from 'firebase-admin';
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore(); const UID = '8xrwHHEKAmd0Us5MCyBJhtkJVBM2';
const snap = await db.collection('users').doc(UID).collection('dados').get();
const out = { em: new Date().toISOString(), docs: {}, nomes: [] };
const QUER = /aporte|divid|provent|rendafixa|^rf|fund|cg20|^rv|prev|evento|bonif|split|meta/i;
snap.forEach(d => { const v = d.data(); const tam = JSON.stringify(v).length; out.nomes.push([d.id, tam]); if (QUER.test(d.id) && tam < 9e6) out.docs[d.id] = v; });
const txt = zlib.gzipSync(Buffer.from(JSON.stringify(out, (k, v) => (v && v.toDate ? v.toDate().toISOString() : v))));
const chave = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', chave, iv);
const corpo = Buffer.concat([c.update(txt), c.final()]), tag = c.getAuthTag();
const ck = crypto.publicEncrypt({ key: fs.readFileSync(new URL('./pub.pem', import.meta.url)), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, chave);
fs.mkdirSync('dados/inv', { recursive: true });
fs.writeFileSync('dados/inv/dump.bin', Buffer.concat([Buffer.from([ck.length >> 8, ck.length & 255]), ck, iv, tag, corpo]));
console.log('docs: ' + out.nomes.length + ' · copiados: ' + Object.keys(out.docs).length + ' · ' + Math.round(corpo.length / 1024) + ' KB cifrados');
