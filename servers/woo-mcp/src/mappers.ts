// Explicit picks, never spreads: anything not listed here (email, phone, street, IP) must not leave the server.
type Obj = Record<string, unknown>;
const rec = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const items = (o: Obj): Obj[] => (Array.isArray(o.line_items) ? (o.line_items as Obj[]) : []);

export const productSummary = (p: Obj) => ({
  id: p.id,
  name: p.name,
  sku: p.sku,
  price: p.price,
  regular_price: p.regular_price,
  status: p.status,
  stock_status: p.stock_status,
  permalink: p.permalink,
});

export const createdProduct = (p: Obj) => ({
  id: p.id,
  name: p.name,
  price: p.price,
  status: p.status,
  permalink: p.permalink,
});

export const orderSummary = (o: Obj) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  total: o.total,
  currency: o.currency,
  date_created: o.date_created,
  customer_first_name: rec(o.billing).first_name,
  items: items(o).map((i) => ({ name: i.name, quantity: i.quantity })),
});

export const orderDetail = (o: Obj) => ({
  id: o.id,
  status: o.status,
  currency: o.currency,
  totals: {
    total: o.total,
    subtotal: o.subtotal,
    tax: o.total_tax,
    shipping: o.shipping_total,
    discount: o.discount_total,
  },
  payment_method_title: o.payment_method_title,
  dates: {
    created: o.date_created,
    modified: o.date_modified,
    paid: o.date_paid,
    completed: o.date_completed,
  },
  billing: { first_name: rec(o.billing).first_name, city: rec(o.billing).city },
  line_items: items(o).map((i) => ({
    name: i.name,
    sku: i.sku,
    quantity: i.quantity,
    total: i.total,
  })),
});

export const statusChange = (id: unknown, previous: unknown, status: unknown) => ({
  id,
  previous_status: previous,
  status,
});
