"use client"

import { useState, useEffect, useCallback, useRef, type RefObject } from "react"
import { Plus, Search, Edit, Trash2, Upload, X, AlertCircle, ChevronDown, EyeOff, Eye, KeyRound, Loader2, ImagePlus } from "lucide-react"
import { toast } from "sonner"
import Link from "next/link"
import { cn, getCurrencySymbol } from "@/lib/utils"
import { Modal } from "@/components/ui/modal"
import { useLocale } from "@/lib/context"
import { adminProductApi, adminCategoryApi, adminCardKeyApi, currencyApi, withMockFallback } from "@/services/api"
import { mockCategories } from "@/lib/mock-data"
import type { ProductDetail, Category, CurrencyItem, WholesaleRule } from "@/types"

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/svg+xml"]
const ALLOWED_IMAGE_ACCEPT = ".jpg,.jpeg,.png,.gif,.webp,.bmp,.svg"
const DEFAULT_WHOLESALE_TARGET = "__default__"

type SpecDraft = {
  client_id: string
  id?: string
  name: string
  price: string
  card_key_count?: number
}

type WholesaleRuleDraft = {
  min_quantity: string
  unit_price: string
}

function createSpecDraft(spec?: Partial<Omit<SpecDraft, "client_id">>): SpecDraft {
  return {
    client_id: `spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    price: "",
    ...spec,
  }
}

function createWholesaleRuleDraft(rule?: Partial<WholesaleRuleDraft>): WholesaleRuleDraft {
  return {
    min_quantity: "",
    unit_price: "",
    ...rule,
  }
}

function createEmptyWholesaleRuleMap() {
  return { [DEFAULT_WHOLESALE_TARGET]: [] } as Record<string, WholesaleRuleDraft[]>
}

function getWholesaleTargetKey(specId?: string | null) {
  return specId ?? DEFAULT_WHOLESALE_TARGET
}

function buildWholesaleRuleMap(rules: WholesaleRule[] = []) {
  const ruleMap = createEmptyWholesaleRuleMap()
  for (const rule of rules) {
    const targetKey = getWholesaleTargetKey(rule.spec_id)
    if (!ruleMap[targetKey]) {
      ruleMap[targetKey] = []
    }
    ruleMap[targetKey].push(createWholesaleRuleDraft({
      min_quantity: String(rule.min_quantity),
      unit_price: String(rule.unit_price),
    }))
  }
  return ruleMap
}

function validateImageFile(file: File): string | null {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return "不支持的图片格式，仅支持 JPG/PNG/GIF/WebP/BMP/SVG"
  }
  if (file.size > 10 * 1024 * 1024) {
    return "图片大小不能超过 10MB"
  }
  return null
}

export default function AdminProductsPage() {
  const { t } = useLocale()
  const [products, setProducts] = useState<ProductDetail[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [currencies, setCurrencies] = useState<CurrencyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [categoryFilter, setCategoryFilter] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("")
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const pageSize = 20

  // Modal states
  const [showModal, setShowModal] = useState(false)
  const [editingProduct, setEditingProduct] = useState<ProductDetail | null>(null)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null)
  const [showImportModal, setShowImportModal] = useState<ProductDetail | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [detailUploading, setDetailUploading] = useState(false)
  const [specsEnabled, setSpecsEnabled] = useState(false)
  const detailTextareaRef = useRef<HTMLTextAreaElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const categoryRef = useRef<HTMLSelectElement>(null)
  const basePriceRef = useRef<HTMLInputElement>(null)
  const [formErrors, setFormErrors] = useState<Record<string, boolean>>({})

  // Form state
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    detail_md: "",
    category_id: "",
    base_price: "",
    currency: "CNY",
    cover_url: "",
    low_stock_threshold: "10",
    wholesale_enabled: false,
    is_enabled: true,
    initial_sales: "",
    sort_order: "",
    delivery_type: "AUTO",
  })
  const [formSpecs, setFormSpecs] = useState<SpecDraft[]>([])
  const [wholesaleRulesByTarget, setWholesaleRulesByTarget] = useState<Record<string, WholesaleRuleDraft[]>>(createEmptyWholesaleRuleMap)
  const [selectedWholesaleTarget, setSelectedWholesaleTarget] = useState(DEFAULT_WHOLESALE_TARGET)
  const [specDeleteConfirm, setSpecDeleteConfirm] = useState<{ idx: number; name: string; count: number } | null>(null)

  // Import modal state
  const [importSpecId, setImportSpecId] = useState("")
  const [importContent, setImportContent] = useState("")
  const [importing, setImporting] = useState(false)

  const fetchProducts = useCallback(async () => {
    setLoading(true)
    try {
      const data = await withMockFallback(
        () => adminProductApi.getList({
          page,
          page_size: pageSize,
          category_id: categoryFilter || undefined,
          is_enabled: statusFilter ? (statusFilter === "enabled" ? 1 : 0) : undefined,
          keyword: search || undefined,
        }),
        () => {
          // Mock fallback: build PaginatedData<ProductDetail> from mock
          const { mockProducts } = require("@/lib/mock-data")
          const { mockProductDetail } = require("@/lib/mock-data")
          let list = mockProducts.map((p: any) => mockProductDetail(p.id)).filter(Boolean)
          if (categoryFilter) list = list.filter((p: ProductDetail) => p.category_id === categoryFilter)
          if (statusFilter === "enabled") list = list.filter((p: ProductDetail) => p.is_enabled !== false)
          if (statusFilter === "disabled") list = list.filter((p: ProductDetail) => p.is_enabled === false)
          if (search) {
            const kw = search.toLowerCase()
            list = list.filter((p: ProductDetail) => p.title.toLowerCase().includes(kw))
          }
          return { list: list.slice((page - 1) * pageSize, page * pageSize), pagination: { page, page_size: pageSize, total: list.length } }
        }
      )
      setProducts(data.list)
      setTotal(data.pagination.total)
    } catch {
      setProducts([])
      setTotal(0)
    } finally {
      setLoading(false)
    }
  }, [page, categoryFilter, statusFilter, search])

  useEffect(() => {
    async function fetchInitData() {
      try {
        const [cats, curs] = await Promise.all([
          withMockFallback(
            () => adminCategoryApi.getList(),
            () => [...mockCategories]
          ),
          withMockFallback(
            () => currencyApi.getList(),
            () => [
              { code: "CNY", name: "人民币", symbol: "¥" },
              { code: "USD", name: "美元", symbol: "$" },
              { code: "USDT", name: "USDT (TRC-20)", symbol: "₮" },
            ] as CurrencyItem[]
          ),
        ])
        setCategories(cats)
        setCurrencies(curs)
      } catch {
        setCategories([])
        setCurrencies([])
      }
    }
    fetchInitData()
  }, [])

  useEffect(() => { fetchProducts() }, [fetchProducts])

  useEffect(() => {
    if (!specsEnabled) {
      if (selectedWholesaleTarget !== DEFAULT_WHOLESALE_TARGET) {
        setSelectedWholesaleTarget(DEFAULT_WHOLESALE_TARGET)
      }
      return
    }

    const targetKeys = formSpecs.map(spec => spec.id ?? spec.client_id)
    if (targetKeys.length === 0) {
      if (selectedWholesaleTarget !== DEFAULT_WHOLESALE_TARGET) {
        setSelectedWholesaleTarget(DEFAULT_WHOLESALE_TARGET)
      }
      return
    }

    if (!targetKeys.includes(selectedWholesaleTarget)) {
      setSelectedWholesaleTarget(targetKeys[0])
    }
  }, [formSpecs, selectedWholesaleTarget, specsEnabled])

  const getCategoryName = (id: string) => categories.find(c => c.id === id)?.name || "-"

  const handleEdit = (product: ProductDetail) => {
    setEditingProduct(product)
    setFormData({
      title: product.title,
      description: product.description || "",
      detail_md: product.detail_md || "",
      category_id: product.category_id,
      base_price: String(product.base_price),
      currency: product.currency || "CNY",
      cover_url: product.cover_url || "",
      low_stock_threshold: String(product.low_stock_threshold ?? 10),
      wholesale_enabled: product.wholesale_enabled === true,
      is_enabled: product.is_enabled !== false,
      initial_sales: String(product.initial_sales ?? ""),
      sort_order: String(product.sort_order ?? ""),
      delivery_type: product.delivery_type || "AUTO",
    })
    const specs = product.specs.map(s => createSpecDraft({
      id: s.id,
      name: s.name,
      price: String(s.price),
      card_key_count: s.card_key_count,
    }))
    setFormSpecs(specs)
    setWholesaleRulesByTarget(buildWholesaleRuleMap(product.wholesale_rules))
    setSelectedWholesaleTarget(product.spec_enabled === true && specs.length > 0
      ? (specs[0].id ?? specs[0].client_id)
      : DEFAULT_WHOLESALE_TARGET)
    setSpecsEnabled(product.spec_enabled === true)
    setShowModal(true)
  }

  const updateWholesaleRules = (targetKey: string, updater: (rules: WholesaleRuleDraft[]) => WholesaleRuleDraft[]) => {
    setWholesaleRulesByTarget((prev) => ({
      ...prev,
      [targetKey]: updater(prev[targetKey] ?? []),
    }))
  }

  const removeSpecDraftAt = (idx: number) => {
    const spec = formSpecs[idx]
    const targetKey = spec.id ?? spec.client_id
    const nextSpecs = formSpecs.filter((_, i) => i !== idx)
    setFormSpecs(nextSpecs)
    setWholesaleRulesByTarget((prev) => {
      const next = { ...prev }
      if (spec.id) {
        next[targetKey] = []
      } else {
        delete next[targetKey]
      }
      return next
    })
    if (selectedWholesaleTarget === targetKey) {
      setSelectedWholesaleTarget(nextSpecs[0]?.id ?? nextSpecs[0]?.client_id ?? DEFAULT_WHOLESALE_TARGET)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await withMockFallback(
        () => adminProductApi.delete(id),
        () => null
      )
      toast.success("删除成功")
      setShowDeleteConfirm(null)
      await fetchProducts()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "删除失败")
    }
  }

  const handleToggleStatus = async (product: ProductDetail) => {
    try {
      await withMockFallback(
        () => adminProductApi.update(product.id, { is_enabled: product.is_enabled === false }),
        () => null
      )
      toast.success(product.is_enabled === false ? "已上架" : "已下架")
      await fetchProducts()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "操作失败")
    }
  }

  const focusFirstError = (errors: Record<string, boolean>, refMap: Record<string, RefObject<HTMLElement | null>>) => {
    for (const key of Object.keys(errors)) {
      if (errors[key] && refMap[key]?.current) {
        refMap[key].current!.focus()
        refMap[key].current!.scrollIntoView({ behavior: "smooth", block: "center" })
        break
      }
    }
  }

  const handleSave = async () => {
    const errors: Record<string, boolean> = {}
    if (!formData.title.trim()) errors.title = true
    if (!formData.category_id) errors.category_id = true
    if (!specsEnabled && (!formData.base_price || parseFloat(formData.base_price) <= 0)) errors.base_price = true

    if (Object.keys(errors).length > 0) {
      setFormErrors(errors)
      const messages: string[] = []
      if (errors.title) messages.push("商品名称")
      if (errors.category_id) messages.push("商品分类")
      if (errors.base_price) messages.push("基础售价")
      toast.error(`请填写：${messages.join("、")}`)
      focusFirstError(errors, { title: titleRef, category_id: categoryRef, base_price: basePriceRef })
      return
    }
    setFormErrors({})

    if (specsEnabled) {
      const specNames = new Set<string>()
      for (const spec of formSpecs) {
        if (!spec.name.trim()) { toast.error("规格名称不能为空"); return }
        if (!spec.price || parseFloat(spec.price) <= 0) { toast.error(`规格「${spec.name || "未命名"}」价格无效`); return }
        const normalizedName = spec.name.trim()
        if (specNames.has(normalizedName)) { toast.error(`规格名称「${normalizedName}」重复`); return }
        specNames.add(normalizedName)
      }
    }

    const normalizedWholesaleRules: Record<string, { min_quantity: number; unit_price: number }[]> = {}
    for (const [targetKey, rules] of Object.entries(wholesaleRulesByTarget)) {
      const normalizedRules: { min_quantity: number; unit_price: number }[] = []
      const usedMinQuantities = new Set<number>()
      const nonEmptyRules = rules.filter(rule => rule.min_quantity.trim() || rule.unit_price.trim())
      for (const rule of nonEmptyRules) {
        const minQuantity = parseInt(rule.min_quantity, 10)
        const unitPrice = parseFloat(rule.unit_price)
        if (!Number.isInteger(minQuantity) || minQuantity <= 0) {
          toast.error("档位购买数量必须是大于 0 的整数")
          return
        }
        if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
          toast.error("档位单价必须大于 0")
          return
        }
        if (usedMinQuantities.has(minQuantity)) {
          toast.error("同一个规格下的档位数量不能重复")
          return
        }
        usedMinQuantities.add(minQuantity)
        normalizedRules.push({ min_quantity: minQuantity, unit_price: unitPrice })
      }
      normalizedRules.sort((a, b) => a.min_quantity - b.min_quantity)
      normalizedWholesaleRules[targetKey] = normalizedRules
    }

    setSaving(true)
    try {
      // Auto-sync base_price = min(spec prices) when specs enabled
      let basePrice = parseFloat(formData.base_price) || 0
      if (specsEnabled && formSpecs.length > 0) {
        const specPrices = formSpecs.map(s => parseFloat(s.price)).filter(p => p > 0)
        if (specPrices.length > 0) {
          basePrice = Math.min(...specPrices)
        }
      }

      const payload = {
        title: formData.title,
        description: formData.description || undefined,
        detail_md: formData.detail_md || undefined,
        category_id: formData.category_id,
        base_price: basePrice,
        currency: formData.currency,
        cover_url: formData.cover_url || undefined,
        low_stock_threshold: parseInt(formData.low_stock_threshold) || 10,
        wholesale_enabled: formData.wholesale_enabled,
        spec_enabled: specsEnabled,
        is_enabled: formData.is_enabled,
        initial_sales: parseInt(formData.initial_sales) || 0,
        sort_order: parseInt(formData.sort_order) || undefined,
        delivery_type: formData.delivery_type,
      }

      let productId: string
      if (editingProduct) {
        await withMockFallback(
          () => adminProductApi.update(editingProduct.id, payload),
          () => null
        )
        productId = editingProduct.id
      } else {
        const created = await withMockFallback(
          () => adminProductApi.create(payload),
          () => ({ id: "mock-id" } as ProductDetail)
        )
        productId = created.id
      }

      // Sync specs：仅在多规格启用时执行增删改，停用时仅通过 spec_enabled=false 控制显示，不删除规格
      if (productId && productId !== "mock-id" && specsEnabled) {
        const existingSpecs = editingProduct?.specs || []
        const existingIds = new Set(existingSpecs.map(s => s.id))
        const keepIds = new Set(formSpecs.filter(s => s.id).map(s => s.id!))

        // Delete removed specs (backend will reject if spec has card keys)
        for (const oldSpec of existingSpecs) {
          if (!keepIds.has(oldSpec.id)) {
            try {
              await adminProductApi.deleteSpec(productId, oldSpec.id)
            } catch (err: unknown) {
              // 后端拒绝删除（有卡密）：提示用户但不中断保存流程
              if (err instanceof Error) toast.error(err.message)
            }
          }
        }
        // Update existing + add new specs
        for (const spec of formSpecs) {
          if (spec.id && existingIds.has(spec.id)) {
            const old = existingSpecs.find(s => s.id === spec.id)
            if (old && (old.name !== spec.name || String(old.price) !== spec.price)) {
              try { await adminProductApi.updateSpec(productId, spec.id, { name: spec.name, price: parseFloat(spec.price) }) } catch { /* ignore */ }
            }
          } else {
            try { await adminProductApi.addSpec(productId, { name: spec.name, price: parseFloat(spec.price) }) } catch { /* ignore */ }
          }
        }
      }

      if (productId && productId !== "mock-id") {
        const latestSpecs = await adminProductApi.getSpecs(productId)
        const targetToSpecId = new Map<string, string | null>([
          [DEFAULT_WHOLESALE_TARGET, null],
        ])

        for (const spec of editingProduct?.specs || []) {
          targetToSpecId.set(spec.id, spec.id)
        }
        for (const spec of latestSpecs) {
          targetToSpecId.set(spec.id, spec.id)
        }
        for (const spec of formSpecs) {
          if (spec.id) {
            targetToSpecId.set(spec.client_id, spec.id)
            targetToSpecId.set(spec.id, spec.id)
            continue
          }
          const matchedSpec = latestSpecs.find(savedSpec => savedSpec.name.trim() === spec.name.trim())
          if (matchedSpec) {
            targetToSpecId.set(spec.client_id, matchedSpec.id)
          }
        }

        const targetsToSync = new Set<string>([
          DEFAULT_WHOLESALE_TARGET,
          ...Object.keys(normalizedWholesaleRules),
          ...((editingProduct?.wholesale_rules || []).map(rule => getWholesaleTargetKey(rule.spec_id))),
        ])

        let wholesaleSyncWarning = false
        for (const targetKey of targetsToSync) {
          const rules = normalizedWholesaleRules[targetKey] ?? []
          const specId = targetToSpecId.get(targetKey)
          if (targetKey !== DEFAULT_WHOLESALE_TARGET && !specId) {
            if (rules.length > 0) {
              wholesaleSyncWarning = true
            }
            continue
          }
          await adminProductApi.setWholesaleRules(productId, {
            spec_id: specId ?? null,
            rules,
          })
        }

        if (wholesaleSyncWarning) {
          toast.success("商品已保存，部分新规格的档位价请重新打开后检查")
        } else {
          toast.success("保存成功")
        }
      } else {
        toast.success("保存成功")
      }

      handleCloseModal()
      await fetchProducts()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "保存失败")
    } finally {
      setSaving(false)
    }
  }

  const handleCloseModal = () => {
    setShowModal(false)
    setEditingProduct(null)
    setFormData({ title: "", description: "", detail_md: "", category_id: "", base_price: "", currency: "CNY", cover_url: "", low_stock_threshold: "10", wholesale_enabled: false, is_enabled: true, initial_sales: "", sort_order: "", delivery_type: "AUTO" })
    setFormSpecs([])
    setWholesaleRulesByTarget(createEmptyWholesaleRuleMap())
    setSelectedWholesaleTarget(DEFAULT_WHOLESALE_TARGET)
    setSpecsEnabled(false)
    setSpecDeleteConfirm(null)
    setFormErrors({})
  }

  const handleImport = async () => {
    if (!showImportModal || !importContent.trim()) {
      toast.error("请输入卡密内容")
      return
    }
    setImporting(true)
    try {
      const result = await withMockFallback(
        () => adminCardKeyApi.import({
          product_id: showImportModal.id,
          spec_id: importSpecId || null,
          content: importContent,
        }),
        () => {
          const lines = importContent.trim().split("\n").filter(Boolean)
          return { id: "mock", product_id: showImportModal.id, spec_id: importSpecId || null, imported_by: "admin", total_count: lines.length, success_count: lines.length, fail_count: 0, fail_detail: null, created_at: new Date().toISOString() }
        }
      )
      toast.success(`导入成功: ${result.success_count} 条${result.fail_count > 0 ? `，失败 ${result.fail_count} 条` : ""}`)
      setShowImportModal(null)
      setImportContent("")
      setImportSpecId("")
      await fetchProducts()
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "导入失败")
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("admin.products")}</h1>
          <p className="text-sm text-muted-foreground">{t("admin.manageProducts")}</p>
        </div>
        <button
          type="button"
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 transition-colors"
          onClick={() => setShowModal(true)}
        >
          <Plus className="h-4 w-4" />
          {t("admin.addProduct")}
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder={t("admin.searchProduct")}
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          />
        </div>
        <div className="relative">
          <select
            className="h-10 appearance-none rounded-lg border border-input bg-background pl-3 pr-8 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={categoryFilter}
            onChange={(e) => { setCategoryFilter(e.target.value); setPage(1) }}
          >
            <option value="">{t("admin.allCategoriesFilter")}</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
        <div className="relative">
          <select
            className="h-10 appearance-none rounded-lg border border-input bg-background pl-3 pr-8 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value); setPage(1) }}
          >
            <option value="">{t("admin.allStatus")}</option>
            <option value="enabled">{t("admin.active")}</option>
            <option value="disabled">{t("admin.inactive")}</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t("admin.product")}</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t("admin.category")}</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t("admin.basePrice")}</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t("admin.stockLabel")}</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t("admin.sold")}</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t("admin.statusLabel")}</th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">{t("admin.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id} className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Link href={`/product/${product.id}`} className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-muted hover:opacity-80 transition-opacity">
                          {product.cover_url ? (
                            <img src={product.cover_url} alt={product.title} className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">N/A</div>
                          )}
                        </Link>
                        <div className="flex flex-col">
                          <Link href={`/product/${product.id}`} className="font-medium text-foreground hover:text-primary hover:underline transition-colors">
                            {product.title}
                          </Link>
                          {product.stock_available <= (product.low_stock_threshold ?? 10) && product.stock_available > 0 && (
                            <span className="text-xs text-amber-500 flex items-center gap-1">
                              <AlertCircle className="h-3 w-3" />
                              {t("admin.lowStock")}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                        {getCategoryName(product.category_id)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium text-foreground">{getCurrencySymbol(product.currency)}{product.base_price}</td>
                    <td className="px-4 py-3">
                      <span className={cn("font-medium", product.stock_available === 0 ? "text-red-500" : product.stock_available <= (product.low_stock_threshold ?? 10) ? "text-amber-500" : "text-foreground")}>
                        {product.stock_available}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-foreground">{product.sales_count ?? 0}</td>
                    <td className="px-4 py-3">
                      <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", product.is_enabled !== false ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground")}>
                        {product.is_enabled !== false ? t("admin.active") : t("admin.inactive")}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" title="编辑" onClick={() => handleEdit(product)}>
                          <Edit className="h-4 w-4" />
                        </button>
                        <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" title="导入卡密" onClick={() => { setShowImportModal(product); setImportSpecId("") }}>
                          <KeyRound className="h-4 w-4" />
                        </button>
                        <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" title={product.is_enabled !== false ? "下架" : "上架"} onClick={() => handleToggleStatus(product)}>
                          {product.is_enabled !== false ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                        <button type="button" className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors" title="删除" onClick={() => setShowDeleteConfirm(product.id)}>
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {products.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-sm text-muted-foreground">{t("admin.noProductData")}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {total > pageSize && (
            <div className="flex items-center justify-between border-t border-border px-4 py-3">
              <span className="text-sm text-muted-foreground">共 {total} 件商品</span>
              <div className="flex items-center gap-2">
                <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground disabled:opacity-50">{t("admin.prevPage")}</button>
                <span className="text-sm text-muted-foreground">{page} / {Math.ceil(total / pageSize)}</span>
                <button type="button" disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage(p => p + 1)} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground disabled:opacity-50">{t("admin.nextPage")}</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Add/Edit Product Modal */}
      <Modal open={showModal} onClose={handleCloseModal} className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <div className="border-b border-border px-6 py-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">
                {editingProduct ? t("admin.editProduct") : t("admin.addProduct")}
              </h2>
              <button type="button" onClick={handleCloseModal} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex flex-col gap-5 p-6">
              {/* 商品名称 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-foreground">{t("admin.productNameReq")}</label>
                <input ref={titleRef} type="text" className={cn("h-10 rounded-lg border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2", formErrors.title ? "border-destructive ring-destructive/20" : "border-input focus:ring-ring")} placeholder="请输入商品名称" value={formData.title} onChange={(e) => { setFormData({ ...formData, title: e.target.value }); setFormErrors(prev => ({ ...prev, title: false })) }} />
              </div>
              {/* 商品简介 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-foreground">{t("admin.productBrief")}</label>
                <input type="text" className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" placeholder="简短描述商品特点" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} />
              </div>
              {/* 分类 + 货币类型 */}
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground">{t("admin.categoryReq")}</label>
                  <select ref={categoryRef} className={cn("h-10 rounded-lg border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2", formErrors.category_id ? "border-destructive ring-destructive/20" : "border-input focus:ring-ring")} value={formData.category_id} onChange={(e) => { setFormData({ ...formData, category_id: e.target.value }); setFormErrors(prev => ({ ...prev, category_id: false })) }}>
                    <option value="">请选择分类</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground">货币类型</label>
                  <select
                    className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    value={formData.currency}
                    onChange={(e) => setFormData({ ...formData, currency: e.target.value })}
                  >
                    {currencies.map(c => (
                      <option key={c.code} value={c.code}>{c.code} - {c.name}</option>
                    ))}
                    {currencies.length === 0 && <option value="CNY">CNY - 人民币</option>}
                  </select>
                </div>
              </div>
              {/* 基础售价 + 封面图片 */}
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground">{t("admin.basePriceReq")}</label>
                  <input ref={basePriceRef} type="number" step="0.01" className={cn("h-10 rounded-lg border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2", formErrors.base_price ? "border-destructive ring-destructive/20" : "border-input focus:ring-ring")} placeholder="0.00" value={formData.base_price} onChange={(e) => { setFormData({ ...formData, base_price: e.target.value }); setFormErrors(prev => ({ ...prev, base_price: false })) }} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground">{t("admin.coverUrl")}</label>
                  <div className="flex gap-2">
                    <input type="text" className="h-10 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" placeholder="https://..." value={formData.cover_url} onChange={(e) => setFormData({ ...formData, cover_url: e.target.value })} />
                    <label className={cn("flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-input bg-background px-3 text-sm font-medium text-foreground hover:bg-accent transition-colors", uploading && "pointer-events-none opacity-50")}>
                      {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                      上传
                      <input
                        type="file"
                        accept={ALLOWED_IMAGE_ACCEPT}
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          const err = validateImageFile(file)
                          if (err) { toast.error(err); e.target.value = ""; return }
                          setUploading(true)
                          try {
                            const result = await adminProductApi.uploadImage(file)
                            setFormData(prev => ({ ...prev, cover_url: result.url }))
                            toast.success("上传成功")
                          } catch (err: unknown) {
                            toast.error(err instanceof Error ? err.message : "上传失败")
                          } finally {
                            setUploading(false)
                            e.target.value = ""
                          }
                        }}
                      />
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">建议 1:1 正方形图片，支持 JPG/PNG/GIF/WebP，用于商品卡和详情页展示</p>
                </div>
              </div>
              {/* 排序权重 + 低库存预警 */}
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground">排序权重</label>
                  <input type="number" className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" placeholder="0" value={formData.sort_order} onChange={(e) => setFormData({ ...formData, sort_order: e.target.value })} />
                  <p className="text-xs text-muted-foreground">数字越小越靠前，默认为 0</p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground">{t("admin.lowStockAlert")}</label>
                  <input type="number" className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" placeholder="10" value={formData.low_stock_threshold} onChange={(e) => setFormData({ ...formData, low_stock_threshold: e.target.value })} />
                </div>
              </div>
              {/* 上架状态 + 初始销量 */}
              <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-foreground">{t("admin.listingStatus")}</label>
                <div className="flex h-10 items-center gap-2">
                  <button type="button" className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", formData.is_enabled ? "bg-primary" : "bg-muted")} onClick={() => setFormData({ ...formData, is_enabled: !formData.is_enabled })}>
                    <span className={cn("absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform", formData.is_enabled && "translate-x-5")} />
                    </button>
                    <span className="text-sm text-muted-foreground">{formData.is_enabled ? "已上架" : "已下架"}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground">初始销量</label>
                  <input type="number" className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" placeholder="0" value={formData.initial_sales} onChange={(e) => setFormData({ ...formData, initial_sales: e.target.value })} />
                  <p className="text-xs text-muted-foreground">前台显示销量 = 真实销量 + 初始销量</p>
                </div>
              </div>
              {/* 档位价格 */}
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-foreground">档位价格</label>
                    <p className="text-xs text-muted-foreground">
                      例如默认 20 元，买满 10 个 15 元/个，买满 30 个 10 元/个
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">启用档位价</span>
                    <button
                      type="button"
                      className={cn("relative h-6 w-11 rounded-full transition-colors", formData.wholesale_enabled ? "bg-primary" : "bg-muted")}
                      onClick={() => setFormData({ ...formData, wholesale_enabled: !formData.wholesale_enabled })}
                    >
                      <span className={cn("absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform", formData.wholesale_enabled && "translate-x-5")} />
                    </button>
                  </div>
                </div>

                {formData.wholesale_enabled ? (
                  <>
                    {specsEnabled && formSpecs.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {formSpecs.map((spec) => {
                          const targetKey = spec.id ?? spec.client_id
                          return (
                            <button
                              key={spec.client_id}
                              type="button"
                              className={cn(
                                "rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors",
                                selectedWholesaleTarget === targetKey
                                  ? "border-primary bg-primary/10 text-primary"
                                  : "border-input text-foreground hover:border-primary/30"
                              )}
                              onClick={() => setSelectedWholesaleTarget(targetKey)}
                            >
                              {spec.name.trim() || "未命名规格"}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">当前按默认售价配置档位价。</p>
                    )}

                    <div className="flex flex-col gap-2">
                      {(wholesaleRulesByTarget[specsEnabled ? selectedWholesaleTarget : DEFAULT_WHOLESALE_TARGET] ?? []).map((rule, idx) => (
                        <div key={`${specsEnabled ? selectedWholesaleTarget : DEFAULT_WHOLESALE_TARGET}-${idx}`} className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">满</span>
                          <input
                            type="number"
                            min="1"
                            className="h-9 w-28 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                            placeholder="数量"
                            value={rule.min_quantity}
                            onChange={(e) => {
                              const targetKey = specsEnabled ? selectedWholesaleTarget : DEFAULT_WHOLESALE_TARGET
                              updateWholesaleRules(targetKey, (currentRules) => {
                                const next = [...currentRules]
                                next[idx] = { ...next[idx], min_quantity: e.target.value }
                                return next
                              })
                            }}
                          />
                          <span className="text-sm text-muted-foreground">个，单价</span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            className="h-9 w-32 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                            placeholder="价格"
                            value={rule.unit_price}
                            onChange={(e) => {
                              const targetKey = specsEnabled ? selectedWholesaleTarget : DEFAULT_WHOLESALE_TARGET
                              updateWholesaleRules(targetKey, (currentRules) => {
                                const next = [...currentRules]
                                next[idx] = { ...next[idx], unit_price: e.target.value }
                                return next
                              })
                            }}
                          />
                          <span className="text-sm text-muted-foreground">元/个</span>
                          <button
                            type="button"
                            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => {
                              const targetKey = specsEnabled ? selectedWholesaleTarget : DEFAULT_WHOLESALE_TARGET
                              updateWholesaleRules(targetKey, (currentRules) => currentRules.filter((_, ruleIdx) => ruleIdx !== idx))
                            }}
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="flex h-9 items-center justify-center gap-1 rounded-lg border border-dashed border-border text-sm text-muted-foreground transition-colors hover:border-primary hover:text-primary"
                        onClick={() => {
                          const targetKey = specsEnabled ? selectedWholesaleTarget : DEFAULT_WHOLESALE_TARGET
                          updateWholesaleRules(targetKey, (currentRules) => [...currentRules, createWholesaleRuleDraft()])
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        添加档位
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">关闭后档位规则仍会保留，但前台不会按阶梯单价生效。</p>
                )}
              </div>
              {/* 发货方式 */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-foreground">发货方式</label>
                <div className="flex gap-3">
                  <button
                    type="button"
                    className={cn(
                      "flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                      formData.delivery_type === "AUTO"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-input text-foreground hover:border-primary/30"
                    )}
                    onClick={() => setFormData({ ...formData, delivery_type: "AUTO" })}
                  >
                    自动发货
                  </button>
                  <button
                    type="button"
                    className={cn(
                      "flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                      formData.delivery_type === "MANUAL"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-input text-foreground hover:border-primary/30"
                    )}
                    onClick={() => setFormData({ ...formData, delivery_type: "MANUAL" })}
                  >
                    手动发货
                  </button>
                </div>
              </div>
              {/* 商品规格 */}
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-foreground">商品规格</label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">启用多规格</span>
                    <button type="button" className={cn("relative h-6 w-11 rounded-full transition-colors", specsEnabled ? "bg-primary" : "bg-muted")} onClick={() => {
                      if (specsEnabled) {
                        setSpecsEnabled(false)
                      } else {
                        setSpecsEnabled(true)
                        if (formSpecs.length === 0) {
                          const specDraft = createSpecDraft()
                          setFormSpecs([specDraft])
                          setSelectedWholesaleTarget(specDraft.client_id)
                        } else {
                          setSelectedWholesaleTarget(formSpecs[0].id ?? formSpecs[0].client_id)
                        }
                      }
                    }}>
                      <span className={cn("absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform", specsEnabled && "translate-x-5")} />
                    </button>
                  </div>
                </div>
                {/* 多规格启用时：可编辑 */}
                {specsEnabled && (
                  <div className="rounded-lg border border-border bg-muted/20 p-3 flex flex-col gap-2">
                    {formSpecs.map((spec, idx) => (
                      <div key={spec.id || idx} className="flex items-center gap-2">
                        <input
                          type="text"
                          className="h-9 flex-1 rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          placeholder="规格名称（如：1个月、6个月）"
                          value={spec.name}
                          onChange={(e) => {
                            const next = [...formSpecs]
                            next[idx] = { ...next[idx], name: e.target.value }
                            setFormSpecs(next)
                          }}
                        />
                        <input
                          type="number"
                          step="0.01"
                          className="h-9 w-32 rounded-lg border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          placeholder="价格"
                          value={spec.price}
                          onChange={(e) => {
                            const next = [...formSpecs]
                            next[idx] = { ...next[idx], price: e.target.value }
                            setFormSpecs(next)
                          }}
                        />
                        <button
                          type="button"
                          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                          onClick={() => {
                            const s = formSpecs[idx]
                            if (s.id && s.card_key_count && s.card_key_count > 0) {
                              setSpecDeleteConfirm({ idx, name: s.name, count: s.card_key_count })
                            } else {
                              removeSpecDraftAt(idx)
                            }
                          }}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="flex h-9 w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                      onClick={() => {
                        const specDraft = createSpecDraft()
                        setFormSpecs(prev => [...prev, specDraft])
                        if (formData.wholesale_enabled) {
                          setSelectedWholesaleTarget(specDraft.client_id)
                        }
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      添加规格
                    </button>
                  </div>
                )}
                {/* 多规格停用但有已保存的规格时：只读置灰展示，提示规格和卡密已保留 */}
                {!specsEnabled && formSpecs.length > 0 && formSpecs.some(s => s.id) && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3 flex flex-col gap-2 opacity-60">
                    <p className="text-xs text-muted-foreground">以下规格及其卡密已保留，重新启用多规格后可继续使用</p>
                    {formSpecs.filter(s => s.id).map((spec) => (
                      <div key={spec.id} className="flex items-center gap-2">
                        <span className="h-9 flex-1 rounded-lg border border-input bg-muted px-3 text-sm text-muted-foreground leading-9">{spec.name}</span>
                        <span className="h-9 w-32 rounded-lg border border-input bg-muted px-3 text-sm text-muted-foreground leading-9">{spec.price}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {/* 详细说明（放在最底部） */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-foreground">{t("admin.detailMd")}</label>
                  <label className={cn("flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors", detailUploading && "pointer-events-none opacity-50")}>
                    {detailUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}
                    插入图片
                    <input
                      type="file"
                      accept={ALLOWED_IMAGE_ACCEPT}
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (!file) return
                        const err = validateImageFile(file)
                        if (err) { toast.error(err); e.target.value = ""; return }
                        setDetailUploading(true)
                        try {
                          const result = await adminProductApi.uploadImage(file)
                          const textarea = detailTextareaRef.current
                          const mdImage = `![${file.name}](${result.url})`
                          if (textarea) {
                            const start = textarea.selectionStart
                            const end = textarea.selectionEnd
                            const text = formData.detail_md
                            const before = text.substring(0, start)
                            const after = text.substring(end)
                            const newText = before + (before.length > 0 && !before.endsWith("\n") ? "\n" : "") + mdImage + "\n" + after
                            setFormData(prev => ({ ...prev, detail_md: newText }))
                            requestAnimationFrame(() => {
                              const newPos = before.length + (before.length > 0 && !before.endsWith("\n") ? 1 : 0) + mdImage.length + 1
                              textarea.selectionStart = textarea.selectionEnd = newPos
                              textarea.focus()
                            })
                          } else {
                            setFormData(prev => ({ ...prev, detail_md: prev.detail_md + (prev.detail_md ? "\n" : "") + mdImage + "\n" }))
                          }
                          toast.success("图片已插入")
                        } catch (err: unknown) {
                          toast.error(err instanceof Error ? err.message : "上传失败")
                        } finally {
                          setDetailUploading(false)
                          e.target.value = ""
                        }
                      }}
                    />
                  </label>
                </div>
                <textarea
                  ref={detailTextareaRef}
                  className="min-h-32 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder={"支持 Markdown 格式编辑\n# 标题  ## 二级标题  ### 三级标题\n**粗体**  *斜体*  空一行为段落换行\n![图片描述](图片URL) — 可点击上方「插入图片」自动生成"}
                  value={formData.detail_md}
                  onChange={(e) => setFormData({ ...formData, detail_md: e.target.value })}
                />
              </div>
            </div>
            <div className="flex justify-end gap-3 border-t border-border px-6 py-4">
              <button type="button" className="rounded-lg border border-input bg-transparent px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors" onClick={handleCloseModal}>{t("admin.cancel")}</button>
              <button type="button" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50" onClick={handleSave} disabled={saving}>{saving ? t("admin.saving") : t("admin.save")}</button>
            </div>
      </Modal>

      {/* Delete Confirmation */}
      <Modal open={showDeleteConfirm !== null} onClose={() => setShowDeleteConfirm(null)} className="max-w-md">
            <div className="flex flex-col gap-4 p-6">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-destructive/10 p-2"><AlertCircle className="h-5 w-5 text-destructive" /></div>
                <div className="flex-1">
                  <h3 className="text-base font-semibold text-foreground">{t("admin.deleteConfirm")}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{t("admin.deleteProductMsg")}</p>
                </div>
              </div>
              <div className="flex justify-end gap-3">
                <button type="button" className="rounded-lg border border-input bg-transparent px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors" onClick={() => setShowDeleteConfirm(null)}>{t("admin.cancel")}</button>
                <button type="button" className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors" onClick={() => showDeleteConfirm && handleDelete(showDeleteConfirm)}>{t("admin.delete")}</button>
              </div>
            </div>
      </Modal>

      {/* Spec Delete Confirmation */}
      <Modal open={specDeleteConfirm !== null} onClose={() => setSpecDeleteConfirm(null)} className="max-w-md">
            <div className="flex flex-col gap-4 p-6">
              <div className="flex items-start gap-3">
                <div className="rounded-full bg-destructive/10 p-2"><AlertCircle className="h-5 w-5 text-destructive" /></div>
                <div className="flex-1">
                  <h3 className="text-base font-semibold text-foreground">确认删除规格</h3>
                  {specDeleteConfirm && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      规格「{specDeleteConfirm.name}」下有 <span className="font-medium text-foreground">{specDeleteConfirm.count}</span> 个有效卡密，删除后可用卡密将自动作废，已售卡密保留在订单记录中。确认删除？
                    </p>
                  )}
                </div>
              </div>
              <div className="flex justify-end gap-3">
                <button type="button" className="rounded-lg border border-input bg-transparent px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors" onClick={() => setSpecDeleteConfirm(null)}>取消</button>
                <button type="button" className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors" onClick={() => {
                  if (specDeleteConfirm) {
                    removeSpecDraftAt(specDeleteConfirm.idx)
                    setSpecDeleteConfirm(null)
                  }
                }}>确认删除</button>
              </div>
            </div>
      </Modal>

      {/* Import Card Keys Modal */}
      <Modal open={showImportModal !== null} onClose={() => setShowImportModal(null)} className="max-w-2xl">
            <div className="border-b border-border px-6 py-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">{t("admin.importKeys")} — {showImportModal?.title}</h2>
              <button type="button" onClick={() => setShowImportModal(null)} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex flex-col gap-5 p-6">
              {showImportModal && showImportModal.specs.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-foreground">{t("admin.selectSpec")}</label>
                  <select className="h-10 rounded-lg border border-input bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" value={importSpecId} onChange={(e) => setImportSpecId(e.target.value)}>
                    <option value="">默认规格</option>
                    {showImportModal.specs.map((spec) => (
                      <option key={spec.id} value={spec.id}>{spec.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-foreground">{t("admin.importContent")}</label>
                <textarea className="min-h-48 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground font-mono break-all focus:outline-none focus:ring-2 focus:ring-ring" placeholder={"请输入卡密，每行一个\n例如：\nXXXX-YYYY-ZZZZ-AAAA\nBBBB-CCCC-DDDD-EEEE"} value={importContent} onChange={(e) => setImportContent(e.target.value)} />
              </div>
              <p className="text-xs text-muted-foreground">提示：支持批量导入，每行一个卡密。导入后会自动增加对应的库存数量。</p>
            </div>
            <div className="flex justify-end gap-3 border-t border-border px-6 py-4">
              <button type="button" className="rounded-lg border border-input bg-transparent px-4 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors" onClick={() => setShowImportModal(null)}>{t("admin.cancel")}</button>
              <button type="button" className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50" onClick={handleImport} disabled={importing}>{importing ? t("admin.saving") : t("admin.import")}</button>
            </div>
      </Modal>
    </div>
  )
}
