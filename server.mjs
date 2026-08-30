import "dotenv/config";
import express from "express";
import Database from "better-sqlite3";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

const db = new Database("reselling.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    generation TEXT NOT NULL,
    model_number TEXT DEFAULT '',
    condition TEXT NOT NULL DEFAULT 'B Grade',
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_cost REAL NOT NULL DEFAULT 0,
    cex_cash_value REAL NOT NULL DEFAULT 0,
    cex_voucher_value REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_number INTEGER NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT,
    status TEXT NOT NULL DEFAULT 'Draft'
  );

  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    stock_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    sale_price_each REAL NOT NULL DEFAULT 0,
    returned_quantity INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (sale_id) REFERENCES sales(id),
    FOREIGN KEY (stock_id) REFERENCES stock(id)
  );
`);

function now() {
  return new Date().toISOString();
}

function money(value) {
  return Number(value || 0);
}

function nextSaleNumber() {
  const row = db.prepare(
    "SELECT MAX(sale_number) AS max FROM sales"
  ).get();

  return Number(row?.max || 0) + 1;
}

function availableStock(stockId) {
  const stock = db.prepare(
    "SELECT quantity FROM stock WHERE id = ?"
  ).get(stockId);

  if (!stock) return 0;

  const allocated = db.prepare(`
    SELECT COALESCE(
      SUM(quantity - returned_quantity), 0
    ) AS total
    FROM sale_items
    WHERE stock_id = ?
  `).get(stockId);

  return stock.quantity - Number(allocated.total || 0);
}

/* DASHBOARD */

app.get("/api/dashboard", (req, res) => {
  try {
    const stock = db.prepare(`
      SELECT
        COALESCE(SUM(quantity), 0) units,
        COALESCE(SUM(quantity * unit_cost), 0) cost,
        COALESCE(SUM(quantity * cex_cash_value), 0) cexCash,
        COALESCE(SUM(quantity * cex_voucher_value), 0) cexVoucher
      FROM stock
    `).get();

    const sales = db.prepare(`
      SELECT
        COUNT(*) sales,
        COALESCE(SUM(
          (
            SELECT COALESCE(
              SUM(
                (quantity - returned_quantity) * sale_price_each
              ), 0
            )
            FROM sale_items
            WHERE sale_id = sales.id
          )
        ), 0) revenue
      FROM sales
      WHERE status = 'Paid'
    `).get();

    const profit = db.prepare(`
      SELECT COALESCE(SUM(
        (si.quantity - si.returned_quantity) *
        (si.sale_price_each - s.unit_cost)
      ), 0) profit
      FROM sale_items si
      JOIN sales sa ON sa.id = si.sale_id
      JOIN stock s ON s.id = si.stock_id
      WHERE sa.status = 'Paid'
    `).get();

    const stockPotential = db.prepare(`
      SELECT COALESCE(SUM(
        quantity * (cex_cash_value - unit_cost)
      ), 0) value
      FROM stock
    `).get();

    res.json({
      stock,
      sales,
      profit: money(profit.profit),
      potentialStockProfit: money(stockPotential.value)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* STOCK */

app.get("/api/stock", (req, res) => {
  try {
    const search = String(req.query.search || "").trim();

    let rows;

    if (search) {
      rows = db.prepare(`
        SELECT *
        FROM stock
        WHERE
          name LIKE ?
          OR generation LIKE ?
          OR model_number LIKE ?
          OR condition LIKE ?
        ORDER BY id DESC
      `).all(
        `%${search}%`,
        `%${search}%`,
        `%${search}%`,
        `%${search}%`
      );
    } else {
      rows = db.prepare(`
        SELECT *
        FROM stock
        ORDER BY id DESC
      `).all();
    }

    rows = rows.map(row => ({
      ...row,
      available_quantity: availableStock(row.id),
      allocated_quantity:
        row.quantity - availableStock(row.id)
    }));

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/stock", (req, res) => {
  try {
    const {
      name,
      generation,
      model_number = "",
      condition = "B Grade",
      quantity = 1,
      unit_cost = 0,
      cex_cash_value = 0,
      cex_voucher_value = 0
    } = req.body;

    if (!name || !generation) {
      return res.status(400).json({
        error: "Product and variant are required."
      });
    }

    if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0) {
      return res.status(400).json({
        error: "Quantity must be a positive whole number."
      });
    }

    const result = db.prepare(`
      INSERT INTO stock (
        name,
        generation,
        model_number,
        condition,
        quantity,
        unit_cost,
        cex_cash_value,
        cex_voucher_value
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      name,
      generation,
      model_number,
      condition,
      Number(quantity),
      Number(unit_cost),
      Number(cex_cash_value),
      Number(cex_voucher_value)
    );

    res.json({
      success: true,
      id: result.lastInsertRowid
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* DELETE STOCK
   Only permitted if none of the stock is allocated to a sale.
*/

app.delete("/api/stock/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const available = availableStock(id);

    const stock = db.prepare(
      "SELECT quantity FROM stock WHERE id = ?"
    ).get(id);

    if (!stock) {
      return res.status(404).json({
        error: "Stock item not found."
      });
    }

    if (available !== stock.quantity) {
      return res.status(400).json({
        error: "This stock is allocated to a sale and cannot be deleted."
      });
    }

    db.prepare(
      "DELETE FROM stock WHERE id = ?"
    ).run(id);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* SALES */

app.post("/api/sales", (req, res) => {
  try {
    const number = nextSaleNumber();

    const result = db.prepare(`
      INSERT INTO sales (
        sale_number,
        created_at,
        status
      )
      VALUES (?, ?, 'Draft')
    `).run(number, now());

    res.json({
      success: true,
      id: result.lastInsertRowid,
      saleNumber: number
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/sales", (req, res) => {
  try {
    const sales = db.prepare(`
      SELECT *
      FROM sales
      ORDER BY created_at DESC, id DESC
    `).all();

    const result = sales.map(sale => {
      const stats = db.prepare(`
        SELECT
          COALESCE(SUM(
            (quantity - returned_quantity)
            * sale_price_each
          ), 0) revenue,

          COALESCE(SUM(returned_quantity), 0) returned_units,

          COALESCE(SUM(
            (quantity - returned_quantity) *
            (sale_price_each - stock.unit_cost)
          ), 0) profit

        FROM sale_items

        JOIN stock
          ON stock.id = sale_items.stock_id

        WHERE sale_id = ?
      `).get(sale.id);

      return {
        ...sale,
        revenue: money(stats.revenue),
        returned_units: Number(stats.returned_units || 0),
        profit: money(stats.profit)
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/sales/:id", (req, res) => {
  try {
    const sale = db.prepare(`
      SELECT *
      FROM sales
      WHERE id = ?
    `).get(req.params.id);

    if (!sale) {
      return res.status(404).json({
        error: "Sale not found."
      });
    }

    const items = db.prepare(`
      SELECT
        sale_items.*,
        stock.name,
        stock.generation,
        stock.model_number,
        stock.condition,
        stock.unit_cost
      FROM sale_items
      JOIN stock
        ON stock.id = sale_items.stock_id
      WHERE sale_id = ?
      ORDER BY sale_items.id
    `).all(req.params.id);

    res.json({
      sale,
      items
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* ADD ITEM */

app.post("/api/sales/:id/items", (req, res) => {
  try {
    const saleId = Number(req.params.id);

    const {
      stock_id,
      quantity,
      sale_price_each
    } = req.body;

    const sale = db.prepare(
      "SELECT * FROM sales WHERE id = ?"
    ).get(saleId);

    if (!sale) {
      return res.status(404).json({
        error: "Sale not found."
      });
    }

    if (sale.status !== "Draft") {
      return res.status(400).json({
        error: "Only draft sales can be edited."
      });
    }

    const stock = db.prepare(
      "SELECT * FROM stock WHERE id = ?"
    ).get(stock_id);

    if (!stock) {
      return res.status(404).json({
        error: "Stock item not found."
      });
    }

    const qty = Number(quantity);
    const price = Number(sale_price_each);

    if (!Number.isInteger(qty) || qty <= 0) {
      return res.status(400).json({
        error: "Quantity must be a positive whole number."
      });
    }

    if (!Number.isFinite(price) || price < 0) {
      return res.status(400).json({
        error: "Invalid sale price."
      });
    }

    const available = availableStock(stock_id);

    if (qty > available) {
      return res.status(400).json({
        error:
          `Only ${available} unit${available === 1 ? "" : "s"} available.`
      });
    }

    db.prepare(`
      INSERT INTO sale_items (
        sale_id,
        stock_id,
        quantity,
        sale_price_each,
        returned_quantity
      )
      VALUES (?, ?, ?, ?, 0)
    `).run(
      saleId,
      stock_id,
      qty,
      price
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* REMOVE DRAFT ITEM */

app.delete("/api/sales/items/:itemId", (req, res) => {
  try {
    const item = db.prepare(`
      SELECT
        sale_items.*,
        sales.status
      FROM sale_items
      JOIN sales
        ON sales.id = sale_items.sale_id
      WHERE sale_items.id = ?
    `).get(req.params.itemId);

    if (!item) {
      return res.status(404).json({
        error: "Sale item not found."
      });
    }

    if (item.status !== "Draft") {
      return res.status(400).json({
        error: "Only draft sale items can be removed."
      });
    }

    db.prepare(
      "DELETE FROM sale_items WHERE id = ?"
    ).run(req.params.itemId);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* PAY */

app.post("/api/sales/:id/pay", (req, res) => {
  try {
    const saleId = Number(req.params.id);

    const sale = db.prepare(
      "SELECT * FROM sales WHERE id = ?"
    ).get(saleId);

    if (!sale) {
      return res.status(404).json({
        error: "Sale not found."
      });
    }

    if (sale.status !== "Draft") {
      return res.status(400).json({
        error: "This sale is not a draft."
      });
    }

    const count = db.prepare(`
      SELECT COUNT(*) count
      FROM sale_items
      WHERE sale_id = ?
    `).get(saleId);

    if (!Number(count.count)) {
      return res.status(400).json({
        error: "Cannot complete an empty sale."
      });
    }

    db.prepare(`
      UPDATE sales
      SET
        status = 'Paid',
        paid_at = ?
      WHERE id = ?
    `).run(now(), saleId);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* CANCEL SALE */

app.post("/api/sales/:id/cancel", (req, res) => {
  try {
    const saleId = Number(req.params.id);

    const sale = db.prepare(
      "SELECT * FROM sales WHERE id = ?"
    ).get(saleId);

    if (!sale) {
      return res.status(404).json({
        error: "Sale not found."
      });
    }

    if (sale.status === "Cancelled") {
      return res.json({ success: true });
    }

    db.prepare(`
      UPDATE sales
      SET status = 'Cancelled'
      WHERE id = ?
    `).run(saleId);

    /*
      We intentionally keep the sale_items rows.
      Because availableStock() only counts items belonging
      to active sales, cancelling the sale automatically
      makes every allocated unit available again.
    */

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* VOID PAID SALE */

app.post("/api/sales/:id/void", (req, res) => {
  try {
    const saleId = Number(req.params.id);

    const sale = db.prepare(
      "SELECT * FROM sales WHERE id = ?"
    ).get(saleId);

    if (!sale) {
      return res.status(404).json({
        error: "Sale not found."
      });
    }

    if (sale.status !== "Paid") {
      return res.status(400).json({
        error: "Only paid sales can be voided."
      });
    }

    db.prepare(`
      UPDATE sales
      SET status = 'Voided'
      WHERE id = ?
    `).run(saleId);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* RETURNS */

app.post("/api/sales/items/:itemId/return", (req, res) => {
  try {
    const quantity = Number(req.body.quantity);

    const item = db.prepare(`
      SELECT
        sale_items.*,
        sales.status
      FROM sale_items
      JOIN sales
        ON sales.id = sale_items.sale_id
      WHERE sale_items.id = ?
    `).get(req.params.itemId);

    if (!item) {
      return res.status(404).json({
        error: "Sale item not found."
      });
    }

    if (item.status !== "Paid") {
      return res.status(400).json({
        error: "Only paid sales can have returns."
      });
    }

    const remaining =
      item.quantity - item.returned_quantity;

    if (
      !Number.isInteger(quantity) ||
      quantity <= 0 ||
      quantity > remaining
    ) {
      return res.status(400).json({
        error:
          `Return quantity must be between 1 and ${remaining}.`
      });
    }

    db.prepare(`
      UPDATE sale_items
      SET returned_quantity =
        returned_quantity + ?
      WHERE id = ?
    `).run(
      quantity,
      req.params.itemId
    );

    res.json({
      success: true
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* MONTHLY PROFIT */

app.get("/api/monthly-sales", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        strftime('%Y-%m', sales.created_at) month,

        COUNT(DISTINCT sales.id) sales,

        COALESCE(SUM(
          (sale_items.quantity - sale_items.returned_quantity)
          * sale_items.sale_price_each
        ), 0) revenue,

        COALESCE(SUM(
          (sale_items.quantity - sale_items.returned_quantity) *
          (
            sale_items.sale_price_each -
            stock.unit_cost
          )
        ), 0) profit,

        COALESCE(
          SUM(sale_items.returned_quantity),
          0
        ) returns

      FROM sales

      LEFT JOIN sale_items
        ON sale_items.sale_id = sales.id

      LEFT JOIN stock
        ON stock.id = sale_items.stock_id

      WHERE sales.status = 'Paid'

      GROUP BY strftime('%Y-%m', sales.created_at)

      ORDER BY month DESC
    `).all();

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* CATCH ALL */

app.use((req, res) => {
  res.sendFile(
    process.cwd() + "/public/index.html"
  );
});

app.listen(PORT, () => {
  console.log(
    `Reselling Manager running on port ${PORT}`
  );
});
