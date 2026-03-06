import { Controller, Get, Post, Put, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { OrdersService } from './orders.service';

@ApiTags('Orders')
@Controller('orders')
export class OrdersController {
  constructor(private ordersService: OrdersService) {}

  @Post()
  @ApiOperation({ summary: 'Create new shipment order' })
  async create(@Body() dto: any) {
    return this.ordersService.createOrder(dto);
  }

  @Get('stats')
  @ApiOperation({ summary: 'Get dashboard statistics' })
  async stats() {
    return this.ordersService.getDashboardStats();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get order by ID' })
  async getOrder(@Param('id') id: string) {
    return this.ordersService.getOrder(id);
  }

  @Get()
  @ApiOperation({ summary: 'List orders' })
  async listOrders(@Query() filter: any) {
    return this.ordersService.listOrders(filter);
  }

  @Put(':id/status/:status')
  @ApiOperation({ summary: 'Update order status' })
  async updateStatus(@Param('id') id: string, @Param('status') status: string) {
    return this.ordersService.updateOrderStatus(id, status);
  }
}
