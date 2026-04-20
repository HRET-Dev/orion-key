"use client"

import { useEffect, useMemo, useState } from "react"
import { ChevronDown, Edit, Plus, Search, TicketPercent, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import { Modal } from "@/components/ui/modal"
import { cn } from "@/lib/utils"
import { useLocale } from "@/lib/context"
import { adminCouponApi, adminProductApi } from "@/services/api"
import type { CouponItem, CouponType, ProductDetail } from "@/types"

const PAGE_SIZE = 20

export default function AdminCouponsPage() {
  const { t } = useLocale()
  const [coupons, setCoupons] = useState<CouponItem[]>([])
  const [products, setProducts] = useState<ProductDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState("")
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [showModal, setShowModal] = useState(false)
  const [editingCoupon, setEditingCoupon] = useState<CouponItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CouponItem | null>(null)
  const [formData, setFormData] = useState({
    code: "",
    name: "",
    type: "FIXED_AMOUNT" as CouponType,
    discount_value: "",
    min_order_amount: "",
    applies_to_all_products: false,
    product_ids: [] as string[],
  })

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const productMap = useMemo(() => {
    const map = new Map<string, ProductDetail>()
    products.forEach((product) => map.set(product.id, product))
    return map
  }, [products])

  const fetchCoupons = async () => {
    setLoading(true)
    try {
      const data = await adminCouponApi.getList({
        page,
        page_size: PAGE_SIZE,
        keyword: search || undefined,
        status: statusFilter || undefined,
      })
      setCoupons(data.list)
      setTotal(data.pagination.total)
    } catch (err: unknown) {
      setCoupons([])
      setTotal(0)
      toast.error(err instanceof Error ? err.message : "获取优惠券失败")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    async function fetchProducts() {
      try {
        const data = await adminProductApi.getList({ page: 1, page_size: 200 })
        if (!cancelled) {
          setProducts(data.list)
        }
      } catch {
        if (!cancelled) {
          setProducts([])
        }
      }
    }
    fetchProducts()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    fetchCoupons()
  }, [page, statusFilter])

  const resetForm = () => {
    setEditingCoupon(null)
    setFormData({
      code: "",
      name: "",
      type: "FIXED_AMOUNT",
      discount_value: "",
      min_order_amount: "",
      applies_to_all_products: false,
      product_ids: [],
    })
  }

  const handleOpenCreate = () => {
    resetForm()
    setShowModal(true)
  }

  const handleOpenEdit = (coupon: CouponItem) => {
    setEditingCoupon(coupon)
    setFormData({
      code: coupon.code,
      name: coupon.name,
      type: coupon.type,
      discount_value: String(coupon.discount_value),
      min_order_amount: String(coupon.min_order_amount ?? 0),
      applies_to_all_products: coupon.applies_to_all_products,
      product_ids: coupon.applicable_product_ids ?? [],
    })
    setShowModal(true)
  }

  const handleCloseModal = () => {
    setShowModal(false)
    resetForm()
  }

  const toggleProduct = (productId: string) => {
    setFormData((prev) => ({
      ...prev,
      product_ids: prev.product_ids.includes(productId)
        ? prev.product_ids.filter((id) => id !== productId)
        : [...prev.product_ids, productId],
    }))
  }

  const handleSearch = async () => {
    if (page !== 1) {
      setPage(1)
      return
    }
    await fetchCoupons()
  }

  const handleSave = async () => {
    const payload = {
      code: formData.code.trim(),
      name: formData.name.trim(),
      type: formData.type,
      discount_value: Number(formData.discount_value),
      min_order_amount: Number(formData.min_order_amount || 0),
      applies_to_all_products: formData.applies_to_all_products,
      product_ids: formData.product_ids,
    }

    if (!payload.code) {
      toast.error("请输入优惠券编码")
      return
    }
    if (!payload.name) {
      toast.error("请输入优惠券名称")
      return
    }
    if (!Number.isFinite(payload.discount_value) || payload.discount_value <= 0) {
      toast.error("请输入有效的优惠值")
      return
    }
    if (payload.type === "PERCENTAGE" && payload.discount_value > 100) {
      toast.error("百分比优惠不能超过 100")
      return
    }
    if (!Number.isFinite(payload.min_order_amount) || payload.min_order_amount < 0) {
      toast.error("请输入有效的最低消费门槛")
      return
    }
    if (!payload.applies_to_all_products && payload.product_ids.length === 0) {
      toast.error("请至少选择一个适用商品")
      return
    }

    setSaving(true)
    try {
      if (editingCoupon) {
        await adminCouponApi.update(editingCoupon.id, payload)
        toast.success("优惠券已更新")
      } else {
        await adminCouponApi.create(payload)
        toast.success("优惠券已创建")
      }
      handleCloseModal()
      await fetchCoupons()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await adminCouponApi.delete(deleteTarget.id)
      toast.success("优惠券已删除")
      setDeleteTarget(null)
      await fetchCoupons()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("admin.coupons")}</h1>
          <p className="text-sm text-muted-foreground">{t("admin.couponsDesc")}</p>
        </div>
        <button
          type="button"
          onClick={handleOpenCreate}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          新建优惠券
        </button>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-[240px] flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            placeholder="搜索优惠券编码或名称"
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <button
          type="button"
          onClick={handleSearch}
          className="rounded-lg border border-input px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-accent"
        >
          搜索
        </button>
        <div className="relative">
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value)
              setPage(1)
            }}
            className="h-10 appearance-none rounded-lg border border-input bg-background pl-3 pr-8 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">全部状态</option>
            <option value="UNUSED">未使用</option>
            <option value="USED">已使用</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-muted/30">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">优惠券</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">优惠类型</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">门槛</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">适用商品</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">状态</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">关联订单</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    加载中...
                  </td>
                </tr>
              ) : coupons.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    暂无优惠券
                  </td>
                </tr>
              ) : coupons.map((coupon) => (
                <tr key={coupon.id} className="hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground">{coupon.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{coupon.code}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground">
                    {coupon.type === "FIXED_AMOUNT" ? `减 ¥${coupon.discount_value}` : `${coupon.discount_value}% 折扣`}
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground">
                    {coupon.min_order_amount > 0 ? `满 ¥${coupon.min_order_amount}` : "无门槛"}
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground">
                    {coupon.applies_to_all_products ? (
                      "全部商品"
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {coupon.applicable_products.slice(0, 2).map((product) => (
                          <span key={product.id}>{product.title}</span>
                        ))}
                        {coupon.applicable_products.length > 2 && (
                          <span className="text-xs text-muted-foreground">等 {coupon.applicable_products.length} 个商品</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn(
                      "inline-flex rounded-full px-2.5 py-1 text-xs font-medium",
                      coupon.status === "USED"
                        ? "bg-emerald-500/10 text-emerald-600"
                        : "bg-amber-500/10 text-amber-600"
                    )}>
                      {coupon.status === "USED" ? "已使用" : "未使用"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground">
                    {coupon.used_order_id ? (
                      <span className="font-mono text-xs">{coupon.used_order_id.slice(0, 8)}...{coupon.used_order_id.slice(-6)}</span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleOpenEdit(coupon)}
                        disabled={coupon.status === "USED"}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        title="编辑"
                      >
                        <Edit className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(coupon)}
                        disabled={coupon.status === "USED"}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
                        title="删除"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            第 {page} / {totalPages} 页，共 {total} 条
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              disabled={page === 1}
              className="rounded-lg border border-input px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
            >
              上一页
            </button>
            <button
              type="button"
              onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
              disabled={page === totalPages}
              className="rounded-lg border border-input px-3 py-1.5 text-sm text-foreground disabled:opacity-50"
            >
              下一页
            </button>
          </div>
        </div>
      )}

      <Modal open={showModal} onClose={handleCloseModal} className="max-w-2xl">
        <div className="border-b border-border px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TicketPercent className="h-5 w-5 text-primary" />
              <h2 className="text-lg font-semibold text-foreground">
                {editingCoupon ? "编辑优惠券" : "新建优惠券"}
              </h2>
            </div>
            <button
              type="button"
              onClick={handleCloseModal}
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="flex flex-col gap-5 p-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">优惠券编码</label>
              <input
                type="text"
                value={formData.code}
                onChange={(e) => setFormData((prev) => ({ ...prev, code: e.target.value.toUpperCase() }))}
                placeholder="如 NEWUSER10"
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">优惠券名称</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="如 新人立减"
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">优惠类型</label>
              <div className="relative">
                <select
                  value={formData.type}
                  onChange={(e) => setFormData((prev) => ({ ...prev, type: e.target.value as CouponType }))}
                  className="h-10 w-full appearance-none rounded-lg border border-input bg-background pl-3 pr-8 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="FIXED_AMOUNT">金额优惠</option>
                  <option value="PERCENTAGE">百分比优惠</option>
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                {formData.type === "FIXED_AMOUNT" ? "优惠金额" : "优惠百分比"}
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={formData.discount_value}
                onChange={(e) => setFormData((prev) => ({ ...prev, discount_value: e.target.value }))}
                placeholder={formData.type === "FIXED_AMOUNT" ? "如 10" : "如 15"}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">最低消费门槛</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={formData.min_order_amount}
                onChange={(e) => setFormData((prev) => ({ ...prev, min_order_amount: e.target.value }))}
                placeholder="0 表示无门槛"
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/20 p-4">
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={formData.applies_to_all_products}
                onChange={(e) => setFormData((prev) => ({ ...prev, applies_to_all_products: e.target.checked }))}
                className="h-4 w-4 rounded border-input"
              />
              <span className="text-sm font-medium text-foreground">适用于全部商品</span>
            </label>
            <p className="mt-2 text-xs text-muted-foreground">
              关闭后可以手动选择这张优惠券允许使用的商品。
            </p>
          </div>

          {!formData.applies_to_all_products && (
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium text-foreground">适用商品</p>
                <p className="text-xs text-muted-foreground">至少选择一个商品</p>
              </div>
              <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
                {products.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-muted-foreground">暂无商品可选</div>
                ) : (
                  <div className="divide-y divide-border">
                    {products.map((product) => (
                      <label key={product.id} className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 hover:bg-muted/20">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-foreground">{product.title}</p>
                          <p className="text-xs text-muted-foreground">¥{product.base_price.toFixed(2)}</p>
                        </div>
                        <input
                          type="checkbox"
                          checked={formData.product_ids.includes(product.id)}
                          onChange={() => toggleProduct(product.id)}
                          className="h-4 w-4 rounded border-input"
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
              {formData.product_ids.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {formData.product_ids.map((productId) => (
                    <span key={productId} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary">
                      {productMap.get(productId)?.title || productId}
                      <button type="button" onClick={() => toggleProduct(productId)}>
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={handleCloseModal}
              className="rounded-lg border border-input px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={deleteTarget !== null} onClose={() => setDeleteTarget(null)} className="max-w-md">
        {deleteTarget && (
          <div className="p-6">
            <h3 className="text-lg font-semibold text-foreground">删除优惠券</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              确认删除优惠券 <span className="font-medium text-foreground">{deleteTarget.name}</span> 吗？此操作不可撤销。
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="rounded-lg border border-input px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleDelete}
                className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
              >
                删除
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
