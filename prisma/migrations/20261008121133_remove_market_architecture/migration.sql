-- CreateIndex
CREATE INDEX "Order_asset_side_status_price_createdAt_idx" ON "Order"("asset", "side", "status", "price", "createdAt");
