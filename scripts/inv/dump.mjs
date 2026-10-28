// Auditoria de proventos da Carteira G20 (28/10/2026): cópia CIFRADA (só a sessão de auditoria lê).
import fs from 'node:fs'; import crypto from 'node:crypto'; import zlib from 'node:zlib'; import admin from 'firebase-admin';
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const dados = admin.firestore().collection('users').doc('8xrwHHEKAmd0Us5MCyBJhtkJVBM2').collection('dados');
const out = { em: new Date().toISOString(), docs: {} };
for (const k of ['cg20Entrada', 'dividendos', 'aportes', 'rvAportes', 'rvDividendos']) { const d = await dados.doc(k).get(); if (d.exists) out.docs[k] = d.data(); }
const txt = zlib.gzipSync(Buffer.from(JSON.stringify(out, (k, v) => (v && v.toDate ? v.toDate().toISOString() : v))));
const chave = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', chave, iv);
const corpo = Buffer.concat([c.update(txt), c.final()]), tag = c.getAuthTag();
const ck = crypto.publicEncrypt({ key: fs.readFileSync(new URL('./pub.pem', import.meta.url)), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, chave);
fs.mkdirSync('dados/inv', { recursive: true }); fs.writeFileSync('dados/inv/dump.bin', Buffer.concat([Buffer.from([ck.length >> 8, ck.length & 255]), ck, iv, tag, corpo]));
