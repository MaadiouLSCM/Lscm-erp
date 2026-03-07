import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'clear-erp-secret-2026';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: { title: 'CLEAR ERP API — LSCM Nigeria Ltd', version: '2.0.0', description: 'Consolidated Logistics ERP\nClients: TotalEnergies EP Nigeria, SNIM Mauritania' },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./src/main.ts'],
};
const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

function auth(req: any, res: any, next: any) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

async function audit(userId: string | null, action: string, entity: string, entityId?: string, oldV?: any, newV?: any) {
  await prisma.auditLog.create({ data: { userId, action, entity, entityId, oldValues: oldV, newValues: newV } }).catch(() => {});
}

app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', app: 'CLEAR ERP', version: '2.0.0', timestamp: new Date() });
});

app.get('/', (_, res) => { res.send(getHTML()); });

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !await bcrypt.compare(password, user.password))
      return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
    await audit(user.id, 'LOGIN', 'User', user.id);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch { res.status(500).json({ error: 'Login failed' }); }
});

app.get('/api/auth/me', auth, async (req: any, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, name: true, email: true, role: true } });
  res.json(user);
});

app.get('/api/purchase-orders', auth, async (req: any, res) => {
  const { status, client, freightMode, search } = req.query;
  const where: any = {};
  if (status) where.status = status;
  if (client) where.client = { contains: client, mode: 'insensitive' };
  if (freightMode) where.freightMode = freightMode;
  if (search) where.OR = [
    { poNumber: { contains: search, mode: 'insensitive' } },
    { description: { contains: search, mode: 'insensitive' } },
    { client: { contains: search, mode: 'insensitive' } },
  ];
  const pos = await prisma.purchaseOrder.findMany({
    where,
    include: {
      pickups: { select: { id: true, status: true, scheduledDate: true } },
      consolidation: { include: { consolidation: { select: { ref: true, status: true } } } },
      documents: { select: { type: true, status: true } },
      customs: { select: { status: true } },
      delivery: { select: { status: true, actualDate: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  res.json(pos);
});

app.get('/api/purchase-orders/:id', auth, async (req, res) => {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: req.params.id },
    include: {
      pickups: { include: { supplier: true, operator: { select: { name: true, email: true } } } },
      consolidation: { include: { consolidation: { include: { shipment: true } } } },
      documents: true, tracking: { orderBy: { eventDate: 'desc' } }, customs: true, delivery: true,
    },
  });
  if (!po) return res.status(404).json({ error: 'PO not found' });
  res.json(po);
});

app.post('/api/purchase-orders', auth, async (req: any, res) => {
  try {
    const po = await prisma.purchaseOrder.create({ data: req.body });
    await audit(req.user.id, 'CREATE', 'PurchaseOrder', po.id, null, req.body);
    const docTypes = po.freightMode === 'AIR'
      ? ['COMMERCIAL_INVOICE', 'PACKING_LIST', 'CCVO', 'AWB']
      : ['COMMERCIAL_INVOICE', 'PACKING_LIST', 'CCVO', 'FORM_C', 'BILL_OF_LADING'];
    await prisma.document.createMany({ data: docTypes.map(type => ({ poId: po.id, type: type as any, status: 'PENDING' })) });
    res.status(201).json(po);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.put('/api/purchase-orders/:id', auth, async (req: any, res) => {
  try {
    const old = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
    const po = await prisma.purchaseOrder.update({ where: { id: req.params.id }, data: req.body });
    await audit(req.user.id, 'UPDATE', 'PurchaseOrder', po.id, old, req.body);
    if (req.body.status && req.body.status !== old?.status) {
      await prisma.trackingEvent.create({ data: { poId: po.id, eventType: 'EXCEPTION', description: `Status: ${old?.status} → ${req.body.status}`, eventDate: new Date(), source: 'Manual' } });
    }
    res.json(po);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.get('/api/pickups', auth, async (_, res) => {
  const pickups = await prisma.pickup.findMany({
    include: { po: { select: { poNumber: true, client: true, description: true } }, supplier: true },
    orderBy: { scheduledDate: 'asc' },
  });
  res.json(pickups);
});

app.post('/api/pickups', auth, async (req: any, res) => {
  try {
    const pickup = await prisma.pickup.create({ data: req.body });
    await prisma.purchaseOrder.update({ where: { id: req.body.poId }, data: { status: 'PICKUP_SCHEDULED' } });
    await prisma.trackingEvent.create({ data: { poId: req.body.poId, eventType: 'PICKUP_SCHEDULED', description: `Pickup: ${pickup.pickupRef}`, eventDate: new Date(), source: 'CLEAR' } });
    await audit(req.user.id, 'CREATE', 'Pickup', pickup.id);
    res.status(201).json(pickup);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.put('/api/pickups/:id', auth, async (req: any, res) => {
  const pickup = await prisma.pickup.update({ where: { id: req.params.id }, data: req.body });
  if (req.body.status === 'COMPLETED') {
    await prisma.purchaseOrder.update({ where: { id: pickup.poId }, data: { status: 'AT_ORIGIN_WAREHOUSE' } });
    await prisma.trackingEvent.create({ data: { poId: pickup.poId, eventType: 'PICKED_UP', description: `Pickup completed: ${pickup.pickupRef}`, eventDate: new Date(), source: 'CLEAR' } });
  }
  res.json(pickup);
});

app.get('/api/consolidations', auth, async (_, res) => {
  const consols = await prisma.consolidation.findMany({
    include: { items: { include: { po: { select: { poNumber: true, client: true, description: true, weightKg: true, volumeCbm: true } } } }, shipment: true },
    orderBy: { updatedAt: 'desc' },
  });
  res.json(consols);
});

app.post('/api/consolidations', auth, async (req: any, res) => {
  const consol = await prisma.consolidation.create({ data: req.body });
  await audit(req.user.id, 'CREATE', 'Consolidation', consol.id);
  res.status(201).json(consol);
});

app.post('/api/consolidations/:id/items', auth, async (req: any, res) => {
  const { poId, weightKg, volumeCbm, packages, marksNumbers } = req.body;
  const item = await prisma.consolidationItem.create({ data: { consolidationId: req.params.id, poId, weightKg, volumeCbm, packages, marksNumbers } });
  const items = await prisma.consolidationItem.findMany({ where: { consolidationId: req.params.id } });
  await prisma.consolidation.update({ where: { id: req.params.id }, data: { totalWeightKg: items.reduce((s,i)=>s+i.weightKg,0), totalCbm: items.reduce((s,i)=>s+i.volumeCbm,0), totalPackages: items.reduce((s,i)=>s+i.packages,0) } });
  await prisma.purchaseOrder.update({ where: { id: poId }, data: { status: 'CONSOLIDATED' } });
  res.status(201).json(item);
});

app.get('/api/documents', auth, async (req, res) => {
  const { poId, status, type } = req.query as any;
  const docs = await prisma.document.findMany({
    where: { ...(poId&&{poId}), ...(status&&{status}), ...(type&&{type}) },
    include: { po: { select: { poNumber: true, client: true } }, uploader: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  res.json(docs);
});

app.put('/api/documents/:id', auth, async (req: any, res) => {
  const doc = await prisma.document.update({ where: { id: req.params.id }, data: { ...req.body, uploadedBy: req.user.id } });
  if (req.body.status === 'APPROVED') {
    const allDocs = await prisma.document.findMany({ where: { poId: doc.poId } });
    if (allDocs.every(d => d.status === 'APPROVED')) {
      await prisma.purchaseOrder.update({ where: { id: doc.poId }, data: { status: 'GREEN_LIGHT' } });
      await prisma.trackingEvent.create({ data: { poId: doc.poId, eventType: 'GREEN_LIGHT_RECEIVED', description: 'All documents approved — GREEN LIGHT ✅', eventDate: new Date(), source: 'CLEAR' } });
    }
  }
  res.json(doc);
});

app.get('/api/documents/checklist/:poId', auth, async (req, res) => {
  const docs = await prisma.document.findMany({ where: { poId: req.params.poId } });
  const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.poId } });
  const required = po?.freightMode === 'AIR' ? ['COMMERCIAL_INVOICE','PACKING_LIST','CCVO','AWB'] : ['COMMERCIAL_INVOICE','PACKING_LIST','CCVO','FORM_C','BILL_OF_LADING'];
  const checklist = required.map(type => { const doc = docs.find(d=>d.type===type); return { type, status: doc?.status||'MISSING', docId: doc?.id }; });
  res.json({ poId: req.params.poId, checklist, complete: checklist.every(d=>d.status==='APPROVED') });
});

app.get('/api/shipments', auth, async (_, res) => {
  const shipments = await prisma.shipment.findMany({
    include: { consolidation: { include: { items: { include: { po: { select: { poNumber: true, client: true } } } } } }, tracking: { orderBy: { eventDate: 'desc' }, take: 5 } },
    orderBy: { updatedAt: 'desc' },
  });
  res.json(shipments);
});

app.post('/api/shipments', auth, async (req: any, res) => {
  const shipment = await prisma.shipment.create({ data: req.body });
  const consol = await prisma.consolidation.findUnique({ where: { id: req.body.consolidationId }, include: { items: true } });
  if (consol) await prisma.purchaseOrder.updateMany({ where: { id: { in: consol.items.map(i=>i.poId) } }, data: { status: 'FREIGHT_BOOKED' } });
  await audit(req.user.id, 'CREATE', 'Shipment', shipment.id);
  res.status(201).json(shipment);
});

app.put('/api/shipments/:id', auth, async (req: any, res) => {
  const shipment = await prisma.shipment.update({ where: { id: req.params.id }, data: req.body });
  const statusMap: any = { SAILING:'IN_TRANSIT', PORT_ARRIVAL:'PORT_ARRIVAL', DISCHARGED:'PORT_ARRIVAL', CUSTOMS_HOLD:'CUSTOMS_HOLD', CUSTOMS_CLEARED:'CUSTOMS_CLEARED' };
  if (req.body.status && statusMap[req.body.status]) {
    const consol = await prisma.consolidation.findUnique({ where: { id: shipment.consolidationId }, include: { items: true } });
    if (consol) await prisma.purchaseOrder.updateMany({ where: { id: { in: consol.items.map(i=>i.poId) } }, data: { status: statusMap[req.body.status] } });
  }
  res.json(shipment);
});

app.get('/api/tracking/:poId', auth, async (req, res) => {
  const events = await prisma.trackingEvent.findMany({ where: { poId: req.params.poId }, orderBy: { eventDate: 'desc' } });
  res.json(events);
});

app.post('/api/tracking', auth, async (req: any, res) => {
  const event = await prisma.trackingEvent.create({ data: req.body });
  res.status(201).json(event);
});

app.get('/api/customs', auth, async (_, res) => {
  const customs = await prisma.customsRecord.findMany({ include: { po: { select: { poNumber: true, client: true, description: true } } }, orderBy: { updatedAt: 'desc' } });
  res.json(customs);
});

app.post('/api/customs', auth, async (req: any, res) => {
  const record = await prisma.customsRecord.create({ data: req.body });
  await audit(req.user.id, 'CREATE', 'CustomsRecord', record.id);
  res.status(201).json(record);
});

app.put('/api/customs/:id', auth, async (req: any, res) => {
  const record = await prisma.customsRecord.update({ where: { id: req.params.id }, data: req.body });
  if (req.body.status === 'RELEASED') {
    await prisma.purchaseOrder.update({ where: { id: record.poId }, data: { status: 'CUSTOMS_CLEARED' } });
    await prisma.trackingEvent.create({ data: { poId: record.poId, eventType: 'CUSTOMS_RELEASED', description: 'Customs cleared ✅', eventDate: new Date(), source: 'CLEAR' } });
  }
  res.json(record);
});

app.get('/api/deliveries', auth, async (_, res) => {
  const deliveries = await prisma.delivery.findMany({ include: { po: { select: { poNumber: true, client: true, description: true } } }, orderBy: { updatedAt: 'desc' } });
  res.json(deliveries);
});

app.post('/api/deliveries', auth, async (req: any, res) => {
  const delivery = await prisma.delivery.create({ data: req.body });
  await prisma.purchaseOrder.update({ where: { id: req.body.poId }, data: { status: 'DELIVERY_SCHEDULED' } });
  res.status(201).json(delivery);
});

app.put('/api/deliveries/:id', auth, async (req: any, res) => {
  const delivery = await prisma.delivery.update({ where: { id: req.params.id }, data: req.body });
  if (req.body.status === 'DELIVERED') {
    await prisma.purchaseOrder.update({ where: { id: delivery.poId }, data: { status: 'DELIVERED' } });
    await prisma.trackingEvent.create({ data: { poId: delivery.poId, eventType: 'DELIVERED', description: `Delivered to ${delivery.deliveryAddr}`, eventDate: new Date(), source: 'CLEAR' } });
  }
  res.json(delivery);
});

app.post('/api/deliveries/:id/pod', auth, async (req: any, res) => {
  const { podRef, receivedBy, condition, notes } = req.body;
  const delivery = await prisma.delivery.update({ where: { id: req.params.id }, data: { status: 'DELIVERED', podRef, receivedBy, condition, notes, actualDate: new Date() } });
  await prisma.purchaseOrder.update({ where: { id: delivery.poId }, data: { status: 'POD_RECEIVED' } });
  await prisma.document.create({ data: { poId: delivery.poId, type: 'POD', status: 'APPROVED', reference: podRef, issueDate: new Date() } });
  res.json({ message: 'POD recorded ✅', delivery });
});

app.get('/api/reports/dashboard', auth, async (_, res) => {
  const [poTotal, byStatus, byMode, byClient, customsHold, docsIncomplete, recentTracking] = await Promise.all([
    prisma.purchaseOrder.count(),
    prisma.purchaseOrder.groupBy({ by: ['status'], _count: true }),
    prisma.purchaseOrder.groupBy({ by: ['freightMode'], _count: true, _sum: { weightKg: true, volumeCbm: true } }),
    prisma.purchaseOrder.groupBy({ by: ['client'], _count: true }),
    prisma.purchaseOrder.count({ where: { status: 'CUSTOMS_HOLD' } }),
    prisma.document.count({ where: { status: { in: ['PENDING','REJECTED'] } } }),
    prisma.trackingEvent.findMany({ orderBy: { eventDate: 'desc' }, take: 10, include: { po: { select: { poNumber: true, client: true } } } }),
  ]);
  res.json({
    kpis: { total: poTotal, delivered: byStatus.find(s=>s.status==='POD_RECEIVED')?._count||0, inTransit: byStatus.find(s=>s.status==='IN_TRANSIT')?._count||0, greenLight: byStatus.find(s=>s.status==='GREEN_LIGHT')?._count||0, customsHold, docsIncomplete },
    byStatus, byMode, byClient, recentTracking, generatedAt: new Date(),
  });
});

app.get('/api/reports/sla', auth, async (_, res) => {
  const delivered = await prisma.purchaseOrder.findMany({ where: { status: 'POD_RECEIVED' }, include: { delivery: true, pickups: { take: 1, orderBy: { scheduledDate: 'asc' } } } });
  const report = delivered.map(po => {
    const start = po.pickups[0]?.scheduledDate, end = po.delivery?.actualDate;
    const days = start && end ? Math.floor((end.getTime()-start.getTime())/86400000) : null;
    const sla = po.freightMode==='AIR' ? 14 : 70;
    return { poNumber: po.poNumber, client: po.client, freightMode: po.freightMode, days, sla, onTime: days!==null ? days<=sla : null };
  });
  const onTime = report.filter(r=>r.onTime===true).length;
  res.json({ summary: { total: report.length, onTime, late: report.filter(r=>r.onTime===false).length, rate: report.length ? Math.round(onTime/report.length*100) : 0 }, details: report });
});

app.get('/api/notifications', auth, async (req: any, res) => {
  const notifs = await prisma.notification.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json(notifs);
});

app.post('/api/seed', async (_, res) => {
  try {
    const h1 = await bcrypt.hash('Admin@LSCM2026', 12);
    const h2 = await bcrypt.hash('Manager@2026', 12);
    await prisma.user.upsert({ where: { email: 'admin@lscmltd.com' }, update: {}, create: { email: 'admin@lscmltd.com', password: h1, name: 'Admin LSCM', role: 'ADMIN' } });
    await prisma.user.upsert({ where: { email: 'mgt@lscmltd.com' }, update: {}, create: { email: 'mgt@lscmltd.com', password: h2, name: 'MGT LSCM', role: 'MANAGER' } });
    res.json({ message: '✅ Seed OK', logins: [{ email:'admin@lscmltd.com', password:'Admin@LSCM2026' }, { email:'mgt@lscmltd.com', password:'Manager@2026' }] });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
function getHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CLEAR ERP — LSCM</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#020817;color:#e2e8f0;min-height:100vh}
    #login-screen{display:flex;align-items:center;justify-content:center;min-height:100vh;background:radial-gradient(ellipse at 50% 30%,#0f2040,#020817 70%)}
    .login-card{background:#0f172a;border:1px solid #1e293b;border-radius:20px;padding:48px 40px;width:400px;max-width:95vw}
    .login-logo{text-align:center;margin-bottom:32px}
    .login-logo h1{font-size:28px;font-weight:900;letter-spacing:-1px;color:#60a5fa}
    .login-logo p{color:#64748b;font-size:13px;margin-top:4px}
    .form-group{margin-bottom:18px}
    .form-group label{display:block;color:#94a3b8;font-size:12px;font-weight:600;margin-bottom:6px;letter-spacing:.5px;text-transform:uppercase}
    .form-group input{width:100%;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 14px;color:#e2e8f0;font-size:14px;outline:none}
    .btn-login{width:100%;background:#1d4ed8;color:#fff;border:none;border-radius:8px;padding:13px;font-size:14px;font-weight:700;cursor:pointer;margin-top:8px}
    #login-error{color:#ef4444;font-size:13px;margin-top:10px;text-align:center;display:none}
    #app{display:none;flex-direction:row;min-height:100vh}
    .sidebar{width:220px;background:#0a0f1e;border-right:1px solid #1e293b;display:flex;flex-direction:column;position:fixed;height:100vh;overflow-y:auto}
    .sidebar-logo{padding:24px 20px 16px;border-bottom:1px solid #1e293b}
    .sidebar-logo h2{color:#60a5fa;font-size:20px;font-weight:900}
    .sidebar-logo p{color:#475569;font-size:10px;margin-top:2px;letter-spacing:1px;text-transform:uppercase}
    .nav-section{padding:16px 12px 8px;color:#475569;font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase}
    .nav-item{display:flex;align-items:center;gap:10px;padding:10px 14px;margin:2px 8px;border-radius:8px;cursor:pointer;color:#64748b;font-size:13px;transition:all .15s}
    .nav-item:hover{background:#1e293b;color:#94a3b8}
    .nav-item.active{background:#1e40af22;color:#60a5fa;border-left:2px solid #3b82f6}
    .sidebar-user{margin-top:auto;padding:16px;border-top:1px solid #1e293b;font-size:12px;color:#64748b}
    .sidebar-user strong{display:block;color:#94a3b8;margin-bottom:4px}
    .btn-logout{background:none;border:1px solid #334155;color:#64748b;border-radius:6px;padding:4px 10px;font-size:11px;cursor:pointer;margin-top:8px}
    .main{margin-left:220px;flex:1;display:flex;flex-direction:column}
    .topbar{background:#0a0f1e;border-bottom:1px solid #1e293b;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
    .topbar h1{font-size:18px;font-weight:700;color:#e2e8f0}
    .content{padding:24px;flex:1}
    .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:24px}
    .kpi-card{background:linear-gradient(135deg,#0f172a,#1e293b);border:1px solid #1e293b;border-radius:12px;padding:18px 20px;border-left:3px solid var(--accent)}
    .kpi-card .label{color:#64748b;font-size:10px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px}
    .kpi-card .value{color:var(--accent);font-size:28px;font-weight:900;line-height:1}
    .kpi-card .sub{color:#475569;font-size:11px;margin-top:4px}
    .table-card{background:#0f172a;border:1px solid #1e293b;border-radius:14px;overflow:hidden;margin-bottom:20px}
    .table-header{padding:14px 20px;border-bottom:1px solid #1e293b;display:flex;align-items:center;justify-content:space-between}
    .table-title{color:#94a3b8;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th{background:#1e293b;color:#64748b;font-weight:600;padding:10px 14px;text-align:left;white-space:nowrap}
    td{padding:11px 14px;border-bottom:1px solid #0a0f1e;color:#94a3b8}
    tr:hover td{background:#1e293b20}
    .mono{font-family:monospace;color:#60a5fa;font-size:12px}
    .badge{border-radius:4px;padding:2px 8px;font-size:10px;font-weight:700;white-space:nowrap}
    .loading{text-align:center;padding:40px;color:#475569;font-size:14px}
    .btn{border-radius:6px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;border:none}
    .btn-primary{background:#1d4ed8;color:#fff}
    .progress-bar{background:#1e293b;border-radius:99px;height:5px;overflow:hidden}
    .progress-fill{height:100%;border-radius:99px;transition:width .5s ease}
  </style>
</head>
<body>
<div id="login-screen">
  <div class="login-card">
    <div class="login-logo">
      <h1>CLEAR ERP</h1>
      <p>LSCM Nigeria Ltd — Logistics Platform</p>
    </div>
    <div class="form-group">
      <label>Email</label>
      <input type="email" id="login-email" placeholder="admin@lscmltd.com" value="admin@lscmltd.com">
    </div>
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="login-password" placeholder="••••••••" value="Admin@LSCM2026">
    </div>
    <button class="btn-login" onclick="doLogin()">Sign In →</button>
    <div id="login-error"></div>
    <div style="text-align:center;margin-top:16px;color:#334155;font-size:11px">Run <code style="color:#60a5fa">/api/seed</code> first to create accounts</div>
  </div>
</div>

<div id="app">
  <nav class="sidebar">
    <div class="sidebar-logo"><h2>CLEAR</h2><p>ERP v2.0 · LSCM</p></div>
    <div class="nav-section">Operations</div>
    <div class="nav-item active" onclick="showPage('dashboard')"><span>📊</span> Dashboard</div>
    <div class="nav-item" onclick="showPage('orders')"><span>📦</span> Purchase Orders</div>
    <div class="nav-item" onclick="showPage('pickups')"><span>🚛</span> Pickups</div>
    <div class="nav-item" onclick="showPage('consolidations')"><span>🗃️</span> Consolidations</div>
    <div class="nav-section">Logistics</div>
    <div class="nav-item" onclick="showPage('shipments')"><span>🚢</span> Shipments</div>
    <div class="nav-item" onclick="showPage('customs')"><span>🛃</span> Customs</div>
    <div class="nav-item" onclick="showPage('deliveries')"><span>🏁</span> Deliveries & POD</div>
    <div class="nav-section">Documents</div>
    <div class="nav-item" onclick="showPage('documents')"><span>📄</span> Document Kit</div>
    <div class="nav-section">Analytics</div>
    <div class="nav-item" onclick="showPage('reports')"><span>📈</span> Reports & KPIs</div>
    <div class="sidebar-user">
      <strong id="sidebar-user-name">...</strong>
      <span id="sidebar-user-role" style="font-size:10px;text-transform:uppercase"></span><br>
      <button class="btn-logout" onclick="doLogout()">Sign Out</button>
    </div>
  </nav>
  <div class="main">
    <div class="topbar"><h1 id="page-title">Dashboard</h1></div>
    <div class="content" id="page-content"><div class="loading">Loading...</div></div>
  </div>
</div>
<script>
const API='';let TOKEN=localStorage.getItem('clear_token');let USER=null;
async function api(path,method='GET',body=null){
  const opts={method,headers:{'Content-Type':'application/json',...(TOKEN?{Authorization:'Bearer '+TOKEN}:{})}};
  if(body)opts.body=JSON.stringify(body);
  const r=await fetch(API+path,opts);const data=await r.json();
  if(!r.ok)throw new Error(data.error||'API error');return data;
}
function statusColor(s){const m={'IN_TRANSIT':'#3b82f6','SAILING':'#3b82f6','CREATED':'#8b5cf6','AT_ORIGIN_WAREHOUSE':'#8b5cf6','PICKUP_SCHEDULED':'#f59e0b','SCHEDULED':'#f59e0b','POD_RECEIVED':'#10b981','DELIVERED':'#10b981','RELEASED':'#10b981','APPROVED':'#10b981','CUSTOMS_HOLD':'#ef4444','ON_HOLD':'#ef4444','REJECTED':'#ef4444','GREEN_LIGHT':'#22c55e','CONSOLIDATED':'#6366f1','PORT_ARRIVAL':'#06b6d4','CUSTOMS_CLEARED':'#84cc16','PENDING':'#94a3b8'};return m[s]||'#6b7280';}
function badge(label,s){const c=statusColor(s||label);return '<span class="badge" style="background:'+c+'22;color:'+c+';border:1px solid '+c+'44">'+label+'</span>';}
function progressBar(pct,color='#3b82f6'){return '<div class="progress-bar" style="width:100px"><div class="progress-fill" style="width:'+pct+'%;background:'+color+'"></div></div>';}
function poProgress(s){const m={CREATED:5,PICKUP_SCHEDULED:10,AT_ORIGIN_WAREHOUSE:30,CONSOLIDATED:40,GREEN_LIGHT:55,FREIGHT_BOOKED:60,IN_TRANSIT:70,PORT_ARRIVAL:80,CUSTOMS_CLEARED:85,DELIVERED:95,POD_RECEIVED:100};return m[s]||0;}
async function doLogin(){
  const email=document.getElementById('login-email').value,password=document.getElementById('login-password').value,errEl=document.getElementById('login-error');
  errEl.style.display='none';
  try{const data=await api('/api/auth/login','POST',{email,password});TOKEN=data.token;USER=data.user;localStorage.setItem('clear_token',TOKEN);
    document.getElementById('login-screen').style.display='none';document.getElementById('app').style.display='flex';
    document.getElementById('sidebar-user-name').textContent=USER.name;document.getElementById('sidebar-user-role').textContent=USER.role;
    showPage('dashboard');}
  catch(e){errEl.style.display='block';errEl.textContent=e.message;}
}
function doLogout(){TOKEN=null;USER=null;localStorage.removeItem('clear_token');location.reload();}
if(TOKEN){api('/api/auth/me').then(u=>{USER=u;document.getElementById('login-screen').style.display='none';document.getElementById('app').style.display='flex';document.getElementById('sidebar-user-name').textContent=u.name;document.getElementById('sidebar-user-role').textContent=u.role;showPage('dashboard');}).catch(()=>{TOKEN=null;localStorage.removeItem('clear_token');});}
function showPage(page){
  document.querySelectorAll('.nav-item').forEach(el=>el.classList.remove('active'));
  event?.target?.closest('.nav-item')?.classList.add('active');
  const titles={dashboard:'Dashboard',orders:'Purchase Orders',pickups:'Pickup & Collection',consolidations:'Consolidation Hub',shipments:'Freight & Shipments',customs:'Customs Clearance',deliveries:'Delivery & POD',documents:'Document Kit',reports:'Reports & Analytics'};
  document.getElementById('page-title').textContent=titles[page]||page;
  document.getElementById('page-content').innerHTML='<div class="loading">⏳ Loading...</div>';
  const pages={dashboard:renderDashboard,orders:renderOrders,pickups:renderPickups,consolidations:renderConsolidations,shipments:renderShipments,customs:renderCustoms,deliveries:renderDeliveries,documents:renderDocuments,reports:renderReports};
  if(pages[page])pages[page]();
}
function kpiCard(icon,label,value,sub,color){return '<div class="kpi-card" style="--accent:'+color+'"><div class="label">'+label+'</div><div class="value">'+value+'</div><div class="sub">'+sub+'</div></div>';}
async function renderDashboard(){
  const data=await api('/api/reports/dashboard');const k=data.kpis;
  document.getElementById('page-content').innerHTML='<div class="kpi-grid">'+kpiCard('📦','Total POs',k.total,'All time','#3b82f6')+kpiCard('✅','Delivered',k.delivered,'POD received','#10b981')+kpiCard('🚢','In Transit',k.inTransit,'Active','#6366f1')+kpiCard('🟢','Green Light',k.greenLight,'Ready','#22c55e')+kpiCard('🚨','Customs Hold',k.customsHold,'Action needed','#ef4444')+kpiCard('📄','Docs Pending',k.docsIncomplete,'Missing','#f59e0b')+'</div><div class="table-card"><div class="table-header"><span class="table-title">📡 Recent Activity</span></div><table><thead><tr><th>PO</th><th>Client</th><th>Event</th><th>When</th></tr></thead><tbody>'+data.recentTracking.map(t=>'<tr><td class="mono">'+(t.po?.poNumber||'—')+'</td><td>'+(t.po?.client?.split(' ')[0]||'—')+'</td><td>'+t.description+'</td><td style="color:#475569;font-size:11px">'+new Date(t.eventDate).toLocaleString()+'</td></tr>').join('')+'</tbody></table></div>';}
async function renderOrders(){
  const pos=await api('/api/purchase-orders');
  document.getElementById('page-content').innerHTML='<div style="display:flex;justify-content:flex-end;margin-bottom:16px"><button class="btn btn-primary" onclick="showCreatePO()">+ New PO</button></div><div class="table-card"><div class="table-header"><span class="table-title">📦 Purchase Orders ('+pos.length+')</span></div><div style="overflow-x:auto"><table><thead><tr><th>PO Number</th><th>Client</th><th>Description</th><th>Mode</th><th>Status</th><th>Progress</th></tr></thead><tbody>'+pos.map(po=>'<tr><td class="mono">'+po.poNumber+'</td><td style="color:#cbd5e1">'+po.client.split(' EP')[0]+'</td><td style="color:#64748b;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+po.description+'</td><td>'+badge(po.freightMode)+'</td><td>'+badge(po.status,po.status)+'</td><td>'+progressBar(poProgress(po.status),statusColor(po.status))+'</td></tr>').join('')+'</tbody></table></div></div>';}
function showCreatePO(){alert('Feature: Create PO form — coming in next update!');}
async function renderPickups(){
  const p=await api('/api/pickups');
  document.getElementById('page-content').innerHTML='<div class="table-card"><div class="table-header"><span class="table-title">🚛 Pickups ('+p.length+')</span></div><div style="overflow-x:auto"><table><thead><tr><th>Ref</th><th>PO</th><th>Client</th><th>City</th><th>Scheduled</th><th>Weight</th><th>Status</th></tr></thead><tbody>'+(p.length?p.map(x=>'<tr><td class="mono">'+x.pickupRef+'</td><td class="mono">'+(x.po?.poNumber||'—')+'</td><td style="color:#cbd5e1">'+(x.po?.client?.split(' EP')[0]||'—')+'</td><td style="color:#94a3b8">'+x.collectionCity+'</td><td style="color:#94a3b8;font-size:12px">'+new Date(x.scheduledDate).toLocaleDateString()+'</td><td style="color:#94a3b8">'+x.weightKg+'kg</td><td>'+badge(x.status,x.status)+'</td></tr>').join(''):'<tr><td colspan="7" style="text-align:center;color:#475569;padding:30px">No pickups yet</td></tr>')+'</tbody></table></div></div>';}
async function renderConsolidations(){
  const c=await api('/api/consolidations');
  document.getElementById('page-content').innerHTML='<div class="table-card"><div class="table-header"><span class="table-title">🗃️ Consolidations ('+c.length+')</span></div><div style="overflow-x:auto"><table><thead><tr><th>Ref</th><th>Hub</th><th>Mode</th><th>Client</th><th>Weight</th><th>CBM</th><th>ETD</th><th>Status</th></tr></thead><tbody>'+(c.length?c.map(x=>'<tr><td class="mono" style="font-weight:700">'+x.ref+'</td><td style="color:#94a3b8">'+x.hubCity+'</td><td>'+badge(x.freightMode)+'</td><td style="color:#cbd5e1">'+x.client.split(' EP')[0]+'</td><td style="color:#94a3b8">'+x.totalWeightKg+'kg</td><td style="color:#94a3b8">'+x.totalCbm+'</td><td style="color:#94a3b8;font-size:12px">'+(x.etd?new Date(x.etd).toLocaleDateString():'TBD')+'</td><td>'+badge(x.status,x.status)+'</td></tr>').join(''):'<tr><td colspan="8" style="text-align:center;color:#475569;padding:30px">No consolidations</td></tr>')+'</tbody></table></div></div>';}
async function renderShipments(){
  const s=await api('/api/shipments');
  document.getElementById('page-content').innerHTML='<div class="table-card"><div class="table-header"><span class="table-title">🚢 Shipments ('+s.length+')</span></div><div style="overflow-x:auto"><table><thead><tr><th>BL/AWB</th><th>Carrier</th><th>Vessel</th><th>POL</th><th>POD</th><th>ETA</th><th>Status</th></tr></thead><tbody>'+(s.length?s.map(x=>'<tr><td class="mono">'+(x.blAwbNumber||'Pending')+'</td><td style="color:#cbd5e1">'+x.carrier+'</td><td style="color:#94a3b8">'+(x.vessel||x.flightNumber||'—')+'</td><td style="color:#64748b">'+x.pol+'</td><td style="color:#64748b">'+x.pod+'</td><td style="color:#94a3b8;font-size:12px">'+(x.eta?new Date(x.eta).toLocaleDateString():'—')+'</td><td>'+badge(x.status,x.status)+'</td></tr>').join(''):'<tr><td colspan="7" style="text-align:center;color:#475569;padding:30px">No shipments</td></tr>')+'</tbody></table></div></div>';}
async function renderCustoms(){
  const c=await api('/api/customs');
  document.getElementById('page-content').innerHTML='<div class="table-card"><div class="table-header"><span class="table-title">🛃 Customs ('+c.length+')</span></div><div style="overflow-x:auto"><table><thead><tr><th>PO</th><th>Client</th><th>Country</th><th>Form C</th><th>Duty</th><th>Status</th><th>Hold Reason</th></tr></thead><tbody>'+(c.length?c.map(x=>'<tr><td class="mono">'+(x.po?.poNumber||'—')+'</td><td style="color:#cbd5e1">'+(x.po?.client?.split(' EP')[0]||'—')+'</td><td style="color:#94a3b8">'+x.country+'</td><td style="color:#94a3b8">'+(x.formCNumber||'—')+'</td><td style="color:#f59e0b">'+(x.dutyAmount?x.currency+' '+x.dutyAmount.toLocaleString():'—')+'</td><td>'+badge(x.status,x.status)+'</td><td style="color:#ef4444;font-size:12px">'+(x.holdReason||'—')+'</td></tr>').join(''):'<tr><td colspan="7" style="text-align:center;color:#475569;padding:30px">No customs records</td></tr>')+'</tbody></table></div></div>';}
async function renderDeliveries(){
  const d=await api('/api/deliveries');
  document.getElementById('page-content').innerHTML='<div class="table-card"><div class="table-header"><span class="table-title">🏁 Deliveries ('+d.length+')</span></div><div style="overflow-x:auto"><table><thead><tr><th>PO</th><th>Client</th><th>Address</th><th>Scheduled</th><th>Actual</th><th>POD Ref</th><th>Status</th></tr></thead><tbody>'+(d.length?d.map(x=>'<tr><td class="mono">'+(x.po?.poNumber||'—')+'</td><td style="color:#cbd5e1">'+(x.po?.client?.split(' EP')[0]||'—')+'</td><td style="color:#64748b;font-size:12px">'+x.deliveryAddr+'</td><td style="color:#94a3b8;font-size:12px">'+(x.scheduledDate?new Date(x.scheduledDate).toLocaleDateString():'—')+'</td><td style="color:#94a3b8;font-size:12px">'+(x.actualDate?new Date(x.actualDate).toLocaleDateString():'—')+'</td><td class="mono">'+(x.podRef||'—')+'</td><td>'+badge(x.status,x.status)+'</td></tr>').join(''):'<tr><td colspan="7" style="text-align:center;color:#475569;padding:30px">No deliveries</td></tr>')+'</tbody></table></div></div>';}
async function renderDocuments(){
  const docs=await api('/api/documents');const grouped={};
  docs.forEach(d=>{if(!grouped[d.po?.poNumber])grouped[d.po?.poNumber]=[];grouped[d.po?.poNumber].push(d);});
  document.getElementById('page-content').innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px">'+( Object.keys(grouped).length?Object.entries(grouped).map(([poNum,dcs])=>'<div class="table-card"><div class="table-header"><span class="table-title mono" style="font-size:12px">'+poNum+'</span></div><div style="padding:14px">'+dcs.map(d=>'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="color:#94a3b8;font-size:12px">'+d.type.replace(/_/g,' ')+'</span>'+badge(d.status,d.status)+'</div>').join('')+'<div style="display:flex;justify-content:space-between;margin-top:12px;padding-top:10px;border-top:1px solid #1e293b"><span style="color:#475569;font-size:11px">'+dcs.filter(d=>d.status==='APPROVED').length+'/'+dcs.length+' approved</span>'+(dcs.every(d=>d.status==='APPROVED')?'<span style="color:#22c55e;font-size:11px">✅ GREEN LIGHT</span>':'<span style="color:#f59e0b;font-size:11px">⚠️ Pending</span>')+'</div></div></div>').join(''):'<div class="table-card" style="grid-column:1/-1"><div style="text-align:center;padding:40px;color:#475569">No documents yet</div></div>')+'</div>';}
async function renderReports(){
  const[dash,sla]=await Promise.all([api('/api/reports/dashboard'),api('/api/reports/sla')]);
  document.getElementById('page-content').innerHTML='<div class="kpi-grid">'+kpiCard('⏱️','SLA Rate',sla.summary.rate+'%',sla.summary.onTime+' on time / '+sla.summary.total+' delivered','#10b981')+kpiCard('🚢','Sea POs',(dash.byMode.find(m=>m.freightMode==='SEA')?._count||0),'Sea freight','#3b82f6')+kpiCard('✈️','Air POs',(dash.byMode.find(m=>m.freightMode==='AIR')?._count||0),'Air freight','#8b5cf6')+'</div><div class="table-card"><div class="table-header"><span class="table-title">📊 SLA Performance</span></div>'+(sla.details.length?'<div style="overflow-x:auto"><table><thead><tr><th>PO</th><th>Client</th><th>Mode</th><th>Days</th><th>SLA</th><th>Result</th></tr></thead><tbody>'+sla.details.map(d=>'<tr><td class="mono">'+d.poNumber+'</td><td>'+d.client.split(' EP')[0]+'</td><td>'+badge(d.freightMode)+'</td><td style="color:#94a3b8">'+(d.days??'In progress')+'</td><td style="color:#64748b">≤'+d.sla+'d</td><td>'+(d.onTime===null?badge('In Progress','PENDING'):d.onTime?'<span style="color:#10b981">✅ On Time</span>':'<span style="color:#ef4444">⚠️ Late</span>')+'</td></tr>').join('')+'</tbody></table></div>':'<div style="text-align:center;padding:30px;color:#475569">No completed deliveries yet</div>')+'</div>';}
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&document.getElementById('login-screen').style.display!=='none')doLogin();});
</script>
</body>
</html>\`;
}

app.listen(PORT, () => {
  console.log('CLEAR ERP v2.0 running on port ' + PORT);
});

export default app;
