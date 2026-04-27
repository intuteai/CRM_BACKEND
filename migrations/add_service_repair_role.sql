-- Migration: Add service_repair role (role_id = 13)
-- Run this against your PostgreSQL database

-- 1. Add role
INSERT INTO roles (role_id, role_name)
VALUES (13, 'service_repair')
ON CONFLICT (role_id) DO NOTHING;

-- 2. Create service_repair_records table
CREATE TABLE IF NOT EXISTS service_repair_records (
    record_id              SERIAL PRIMARY KEY,
    customer_name          VARCHAR(255) NOT NULL,
    dispatch_material_no   VARCHAR(255),
    part_details           TEXT,
    chalan_photo_url       TEXT,
    receiving_quantity     NUMERIC,
    dispatch_quantity      NUMERIC,
    fault_query            TEXT,
    actual_issue           TEXT,
    delivery_challan_photo_url TEXT,
    repaired_photos_urls   TEXT[],
    repair_status          VARCHAR(50)  NOT NULL DEFAULT 'pending'
                               CHECK (repair_status IN ('pending','in_progress','repaired','dispatched')),
    responsibility_person  VARCHAR(255),
    testing_responsibility VARCHAR(255),
    remarks                TEXT,
    sent_date              DATE,
    created_by             INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 3. Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION update_service_repair_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_service_repair_updated_at ON service_repair_records;
CREATE TRIGGER trg_service_repair_updated_at
    BEFORE UPDATE ON service_repair_records
    FOR EACH ROW EXECUTE FUNCTION update_service_repair_updated_at();

-- 4. Add service_type column (repair vs product bought for service)
ALTER TABLE service_repair_records
    ADD COLUMN IF NOT EXISTS service_type VARCHAR(50) NOT NULL DEFAULT 'repair'
        CHECK (service_type IN ('repair', 'purchase_for_service'));

-- 5. Permissions for service_repair role
INSERT INTO permissions (role_id, module, can_read, can_write, can_delete)
SELECT 13, 'ServiceRepair', true, true, false
WHERE NOT EXISTS (
    SELECT 1 FROM permissions WHERE role_id = 13 AND module = 'ServiceRepair'
);

-- 5. Admin also gets full access to ServiceRepair module
INSERT INTO permissions (role_id, module, can_read, can_write, can_delete)
SELECT 1, 'ServiceRepair', true, true, true
WHERE NOT EXISTS (
    SELECT 1 FROM permissions WHERE role_id = 1 AND module = 'ServiceRepair'
);
