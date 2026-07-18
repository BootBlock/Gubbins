/**
 * Public surface of the suppliers feature (issue #384).
 *
 * Suppliers are referenced by both inventory (`supplier_parts`) and purchasing
 * (`purchase_orders`), so the dictionary's hooks and its one entry control live here rather
 * than inside either consumer — importing across two sibling features would make one of them
 * arbitrarily the owner.
 */
export { supplierKeys, useSupplier, useSuppliers } from './queries';
export { useCreateSupplier, useDeleteSupplier, useMergeSuppliers, useUpdateSupplier } from './mutations';
export { SuppliersScreen } from './SuppliersScreen';
export { SupplierPicker, type SupplierPickerProps } from './components/SupplierPicker';
export { EMPTY_SUPPLIER_VALUE, supplierRefFrom, type SupplierPickerValue } from './supplier-picker-value';
