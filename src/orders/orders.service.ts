import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OrdersService {
  constructor(private prisma: PrismaService) {}

  private generateOrderReference(supplierId: string): string {
    const date = new Date();
    const y = date.getFullYear().toString().slice(2);
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const r = Math.floor(Math.random() * 9000 + 1000);
    const s = (supplierId || 'GEN').toString().slice(0, 3).toUpperCase();
    return `LSCM-${s}-${y}${m}${d}-${r}`;
  }

  async createOrder(dto: any) {
    if (dto.poNumber) {
      const existing = await this.prisma.shipmentOrder.findFirst({ where: { poNumber: dto.poNumber } });
      if (existing) throw new ConflictException(`PO ${dto.poNumber} already exists`);
    }
    const orderRef = this.generateOrderReference(dto.supplierId);
    return this.prisma.shipmentOrder.create({
      data: { orderReference: orderRef, ...dto, status: 'DRAFT', phase: 'PREPARATION' },
    });
  }

  async getOrder(id: string) {
    const order = await this.prisma.shipmentOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return order;
  }

  async listOrders(filter: any = {}) {
    const { page = 1, limit = 20, status, transportMode } = filter;
    const where: any = {};
    if (status) where.status = status;
    if (transportMode) where.transportMode = transportMode;
    const [orders, total] = await Promise.all([
      this.prisma.shipmentOrder.findMany({ where, skip: (page-1)*limit, take: Number(limit), orderBy: { createdAt: 'desc' } }),
      this.prisma.shipmentOrder.count({ where }),
    ]);
    return { data: orders, meta: { total, page: Number(page), limit: Number(limit) } };
  }

  async updateOrder(id: string, dto: any) {
    await this.getOrder(id);
    return this.prisma.shipmentOrder.update({ where: { id }, data: dto });
  }

  async updateOrderStatus(id: string, status: string) {
    await this.getOrder(id);
    return this.prisma.shipmentOrder.update({ where: { id }, data: { status } });
  }

  async getDashboardStats() {
    const [total, draft, inTransit, delivered] = await Promise.all([
      this.prisma.shipmentOrder.count(),
      this.prisma.shipmentOrder.count({ where: { status: 'DRAFT' } }),
      this.prisma.shipmentOrder.count({ where: { status: 'IN_TRANSIT' } }),
      this.prisma.shipmentOrder.count({ where: { status: 'DELIVERED' } }),
    ]);
    return { total, draft, inTransit, delivered };
  }
}
