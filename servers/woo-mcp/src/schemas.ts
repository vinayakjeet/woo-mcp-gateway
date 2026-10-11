import * as z from 'zod';

export const ORDER_STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
] as const;

const page = z.number().int().min(1).default(1).describe('Page number, starting at 1');
const perPage = z.number().int().min(1).max(50).default(20).describe('Results per page, 1 to 50');
const orderId = z.number().int().positive().describe('WooCommerce order id');

export const getInfoInput = z.object({});

export const listProductsInput = z.object({
  search: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe('Text to match in product name or description'),
  status: z.enum(['publish', 'draft', 'any']).default('any'),
  page,
  per_page: perPage,
});

export const createProductInput = z.object({
  name: z.string().min(1).max(200),
  regular_price: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/)
    .describe('Price in store currency, for example "199.50"'),
  description: z.string().max(5000).optional(),
  sku: z.string().min(1).max(100).optional(),
  stock_quantity: z.number().int().min(0).optional(),
  status: z.enum(['publish', 'draft']).default('publish'),
});

export const listOrdersInput = z.object({
  date: z
    .enum(['today', 'yesterday', 'last_7_days'])
    .optional()
    .describe('Resolved in the store timezone'),
  after: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('ISO 8601 lower bound; do not combine with date'),
  before: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('ISO 8601 upper bound; do not combine with date'),
  status: z.enum([...ORDER_STATUSES, 'any']).optional(),
  page,
  per_page: perPage,
});

export const getOrderInput = z.object({ order_id: orderId });

export const updateOrderStatusInput = z.object({
  order_id: orderId,
  status: z.enum(ORDER_STATUSES),
  note: z.string().min(1).max(1000).optional().describe('Private order note'),
});
