import {
	append,
	conflatenate,
	flatMorph,
	printable,
	spliterate,
	throwInternalError,
	throwParseError,
	type array,
	type dict,
	type Key,
	type listable
} from "@ark/util"
import {
	BaseConstraint,
	constraintKeyParser,
	flattenConstraints,
	intersectConstraints
} from "../constraint.ts"
import { intrinsic } from "../intrinsic.ts"
import type { nodeOfKind } from "../kinds.ts"
import type { GettableKeyOrNode, KeyOrKeyNode } from "../node.ts"
import type { Morph } from "../roots/morph.ts"
import { typeOrTermExtends, type BaseRoot } from "../roots/root.ts"
import type { BaseScope } from "../scope.ts"
import type { NodeCompiler } from "../shared/compile.ts"
import type {
	attachmentsOf,
	BaseNormalizedSchema,
	declareNode
} from "../shared/declare.ts"
import { Disjoint } from "../shared/disjoint.ts"
import {
	implementNode,
	type nodeImplementationOf,
	type StructuralKind
} from "../shared/implement.ts"
import { intersectNodesRoot } from "../shared/intersections.ts"
import type { JsonSchema } from "../shared/jsonSchema.ts"
import {
	$ark,
	registeredReference,
	type RegisteredReference
} from "../shared/registry.ts"
import { ToJsonSchema } from "../shared/toJsonSchema.ts"
import {
	traverseKey,
	type InternalTraversal,
	type TraversalKind,
	type TraverseAllows,
	type TraverseApply
} from "../shared/traversal.ts"
import {
	hasArkKind,
	isNode,
	makeRootAndArrayPropertiesMutable
} from "../shared/utils.ts"
import type { Index } from "./index.ts"
import { Optional, type OptionalNode } from "./optional.ts"
import type { Prop } from "./prop.ts"
import type { Required } from "./required.ts"
import type { Sequence } from "./sequence.ts"

/**
 * - `"ignore"` (default) - allow and preserve extra properties
 * - `"reject"` - disallow extra properties
 * - `"delete"` - clone and remove extra properties from output
 */
export type UndeclaredKeyBehavior = "ignore" | UndeclaredKeyHandling

export type UndeclaredKeyHandling = "reject" | "delete"

export declare namespace Structure {
	export interface Schema extends BaseNormalizedSchema {
		readonly optional?: readonly Optional.Schema[]
		readonly required?: readonly Required.Schema[]
		readonly index?: readonly Index.Schema[]
		readonly sequence?: Sequence.Schema
		readonly undeclared?: UndeclaredKeyBehavior
	}

	export interface Inner {
		readonly optional?: readonly Optional.Node[]
		readonly required?: readonly Required.Node[]
		readonly index?: readonly Index.Node[]
		readonly sequence?: Sequence.Node
		readonly undeclared?: UndeclaredKeyHandling
	}

	export namespace Inner {
		export type mutable = makeRootAndArrayPropertiesMutable<Inner>
	}

	export interface Declaration
		extends declareNode<{
			kind: "structure"
			schema: Schema
			normalizedSchema: Schema
			inner: Inner
			prerequisite: object
			childKind: StructuralKind
		}> {}

	export type Node = StructureNode
}

const createStructuralWriter =
	(childStringProp: "expression" | "description") => (node: StructureNode) => {
		if (node.props.length || node.index) {
			const parts = node.index?.map(index => index[childStringProp]) ?? []
			for (const prop of node.props) parts.push(prop[childStringProp])

			if (node.undeclared) parts.push(`+ (undeclared): ${node.undeclared}`)

			const objectLiteralDescription = `{ ${parts.join(", ")} }`
			return node.sequence ?
					`${objectLiteralDescription} & ${node.sequence.description}`
				:	objectLiteralDescription
		}
		return node.sequence?.description ?? "{}"
	}

const structuralDescription = createStructuralWriter("description")
const structuralExpression = createStructuralWriter("expression")

const intersectPropsAndIndex = <
	l extends nodeOfKind<"required"> | nodeOfKind<"optional">
>(
	l: l,
	r: nodeOfKind<"index">,
	$: BaseScope
): l | Disjoint | null => {
	const kind = l.required ? "required" : "optional"

	if (!r.signature.allows(l.key)) return null

	const value = intersectNodesRoot(l.value, r.value, $)
	if (value instanceof Disjoint) {
		return kind === "optional" ?
				($.node("optional", {
					key: l.key,
					value: $ark.intrinsic.never.internal
				}) as l)
			:	value.withPrefixKey(l.key, l.kind)
	}

	return null
}

const implementation: nodeImplementationOf<Structure.Declaration> =
	implementNode<Structure.Declaration>({
		kind: "structure",
		hasAssociatedError: false,
		normalize: schema => schema,
		applyConfig: (schema, config) => {
			if (!schema.undeclared && config.onUndeclaredKey !== "ignore") {
				return {
					...schema,
					undeclared: config.onUndeclaredKey
				}
			}
			return schema
		},
		keys: {
			required: {
				child: true,
				parse: constraintKeyParser("required"),
				reduceIo: (ioKind, inner, nodes) => {
					// ensure we don't overwrite nodes added by optional
					inner.required = append(
						inner.required,
						nodes!.map(node => node[ioKind] as Required.Node)
					)
					return
				}
			},
			optional: {
				child: true,
				parse: constraintKeyParser("optional"),
				reduceIo: (ioKind, inner, nodes) => {
					if (ioKind === "in") {
						inner.optional = nodes!.map(node => node.in as OptionalNode)
						return
					}

					for (const node of nodes!) {
						inner[node.outProp.kind] = append(
							inner[node.outProp.kind],
							node.outProp.out as Prop.Node
						) as never
					}
				}
			},
			index: {
				child: true,
				parse: constraintKeyParser("index")
			},
			sequence: {
				child: true,
				parse: constraintKeyParser("sequence")
			},
			undeclared: {
				parse: behavior => (behavior === "ignore" ? undefined : behavior),
				reduceIo: (ioKind, inner, value) => {
					if (value !== "delete") return

					// if base is "delete", undeclared keys are "ignore" (i.e. unconstrained)
					// on input and "reject" on output

					if (ioKind === "in") delete inner.undeclared
					else inner.undeclared = "reject"
				}
			}
		},
		defaults: {
			description: structuralDescription
		},
		intersections: {
			structure: (l, r, ctx) => {
				const lInner = { ...l.inner }
				const rInner = { ...r.inner }
				const disjointResult = new Disjoint()
				if (l.undeclared) {
					const lKey = l.keyof()
					for (const k of r.requiredKeys) {
						if (!lKey.allows(k)) {
							disjointResult.add(
								"presence",
								$ark.intrinsic.never.internal,
								r.propsByKey[k]!.value,
								{
									path: [k]
								}
							)
						}
					}

					if (rInner.optional)
						rInner.optional = rInner.optional.filter(n => lKey.allows(n.key))
					if (rInner.index) {
						rInner.index = rInner.index.flatMap(n => {
							if (n.signature.extends(lKey)) return n
							const indexOverlap = intersectNodesRoot(lKey, n.signature, ctx.$)
							if (indexOverlap instanceof Disjoint) return []
							const normalized = normalizeIndex(indexOverlap, n.value, ctx.$)
							if (normalized.required) {
								rInner.required = conflatenate(
									rInner.required,
									normalized.required
								)
							}
							if (normalized.optional) {
								rInner.optional = conflatenate(
									rInner.optional,
									normalized.optional
								)
							}
							return normalized.index ?? []
						})
					}
				}
				if (r.undeclared) {
					const rKey = r.keyof()
					for (const k of l.requiredKeys) {
						if (!rKey.allows(k)) {
							disjointResult.add(
								"presence",
								l.propsByKey[k]!.value,
								$ark.intrinsic.never.internal,
								{
									path: [k]
								}
							)
						}
					}

					if (lInner.optional)
						lInner.optional = lInner.optional.filter(n => rKey.allows(n.key))
					if (lInner.index) {
						lInner.index = lInner.index.flatMap(n => {
							if (n.signature.extends(rKey)) return n
							const indexOverlap = intersectNodesRoot(rKey, n.signature, ctx.$)
							if (indexOverlap instanceof Disjoint) return []
							const normalized = normalizeIndex(indexOverlap, n.value, ctx.$)
							if (normalized.required) {
								lInner.required = conflatenate(
									lInner.required,
									normalized.required
								)
							}
							if (normalized.optional) {
								lInner.optional = conflatenate(
									lInner.optional,
									normalized.optional
								)
							}

							return normalized.index ?? []
						})
					}
				}

				const baseInner: Structure.Inner.mutable = {}

				if (l.undeclared || r.undeclared) {
					baseInner.undeclared =
						l.undeclared === "reject" || r.undeclared === "reject" ?
							"reject"
						:	"delete"
				}

				const childIntersectionResult = intersectConstraints({
					kind: "structure",
					baseInner,
					l: flattenConstraints(lInner),
					r: flattenConstraints(rInner),
					roots: [],
					ctx
				})

				if (childIntersectionResult instanceof Disjoint)
					disjointResult.push(...childIntersectionResult)

				if (disjointResult.length) return disjointResult

				return childIntersectionResult
			}
		},
		reduce: (inner, $) => {
			if (inner.index) {
				if (!(inner.required || inner.optional)) return

				let updated = false

				const requiredProps = inner.required ?? []
				const optionalProps = inner.optional ?? []
				const newOptionalProps: OptionalNode[] = [...optionalProps]

				for (const index of inner.index) {
					for (const requiredProp of requiredProps) {
						const intersection = intersectPropsAndIndex(requiredProp, index, $)
						if (intersection instanceof Disjoint) return intersection
					}

					for (const [indx, optionalProp] of optionalProps.entries()) {
						const intersection = intersectPropsAndIndex(optionalProp, index, $)
						if (intersection instanceof Disjoint) return intersection
						if (intersection === null) continue
						newOptionalProps[indx] = intersection
						updated = true
					}
				}

				if (updated) {
					return $.node(
						"structure",
						{ ...inner, optional: newOptionalProps },
						{ prereduced: true }
					)
				}
			}
		}
	})

export class StructureNode extends BaseConstraint<Structure.Declaration> {
	impliedBasis: BaseRoot = $ark.intrinsic.object.internal
	impliedSiblings = this.children.flatMap(
		n => (n.impliedSiblings as BaseConstraint[]) ?? []
	)

	props: array<Prop.Node> = conflatenate<Prop.Node>(
		this.required,
		this.optional
	)

	propsByKey: Record<Key, Prop.Node | undefined> = flatMorph(
		this.props,
		(i, node) => [node.key, node] as const
	)

	propsByKeyReference: RegisteredReference = registeredReference(
		this.propsByKey
	)

	expression: string = structuralExpression(this)

	requiredKeys: Key[] = this.required?.map(node => node.key) ?? []

	optionalKeys: Key[] = this.optional?.map(node => node.key) ?? []

	literalKeys: Key[] = [...this.requiredKeys, ...this.optionalKeys]

	_keyof: BaseRoot | undefined
	keyof(): BaseRoot {
		if (this._keyof) return this._keyof
		let branches = this.$.units(this.literalKeys).branches
		if (this.index) {
			for (const { signature } of this.index)
				branches = branches.concat(signature.branches)
		}
		return (this._keyof = this.$.node("union", branches))
	}

	map(flatMapProp: PropFlatMapper): StructureNode {
		return this.$.node(
			"structure",
			this.props
				.flatMap(flatMapProp)
				.reduce((structureInner: Structure.Inner.mutable, mapped) => {
					const originalProp = this.propsByKey[mapped.key]

					if (isNode(mapped)) {
						if (mapped.kind !== "required" && mapped.kind !== "optional") {
							return throwParseError(
								`Map result must have kind "required" or "optional" (was ${mapped.kind})`
							)
						}

						structureInner[mapped.kind] = append(
							structureInner[mapped.kind] as any,
							mapped
						)
						return structureInner
					}

					const mappedKind = mapped.kind ?? originalProp?.kind ?? "required"

					// extract the inner keys from the map result in case a node was spread,
					// which would otherwise lead to invalid keys
					const mappedPropInner: Prop.Inner = flatMorph(
						mapped as BaseMappedPropInner,
						(k, v) => (k in Optional.implementation.keys ? [k, v] : [])
					) as never

					structureInner[mappedKind] = append(
						structureInner[mappedKind] as any,
						this.$.node(mappedKind, mappedPropInner)
					)

					return structureInner
				}, {})
		)
	}

	assertHasKeys(keys: array<KeyOrKeyNode>): void {
		const invalidKeys = keys.filter(k => !typeOrTermExtends(k, this.keyof()))

		if (invalidKeys.length) {
			return throwParseError(
				writeInvalidKeysMessage(this.expression, invalidKeys)
			)
		}
	}

	get(indexer: GettableKeyOrNode, ...path: array<GettableKeyOrNode>): BaseRoot {
		let value: BaseRoot | undefined
		let required = false

		const key = indexerToKey(indexer)

		if (
			(typeof key === "string" || typeof key === "symbol") &&
			this.propsByKey[key]
		) {
			value = this.propsByKey[key]!.value
			required = this.propsByKey[key]!.required
		}

		if (this.index) {
			for (const n of this.index) {
				if (typeOrTermExtends(key, n.signature))
					value = value?.and(n.value) ?? n.value
			}
		}

		if (
			this.sequence &&
			typeOrTermExtends(key, $ark.intrinsic.nonNegativeIntegerString)
		) {
			if (hasArkKind(key, "root")) {
				if (this.sequence.variadic)
					// if there is a variadic element and we're accessing an index, return a union
					// of all possible elements. If there is no variadic expression, we're in a tuple
					// so this access wouldn't be safe based on the array indices
					value = value?.and(this.sequence.element) ?? this.sequence.element
			} else {
				const index = Number.parseInt(key as string)
				if (index < this.sequence.prevariadic.length) {
					const fixedElement = this.sequence.prevariadic[index].node
					value = value?.and(fixedElement) ?? fixedElement
					required ||= index < this.sequence.prefixLength
				} else if (this.sequence.variadic) {
					// ideally we could return something more specific for postfix
					// but there is no way to represent it using an index alone
					const nonFixedElement = this.$.node(
						"union",
						this.sequence.variadicOrPostfix
					)
					value = value?.and(nonFixedElement) ?? nonFixedElement
				}
			}
		}

		if (!value) {
			if (
				this.sequence?.variadic &&
				hasArkKind(key, "root") &&
				key.extends($ark.intrinsic.number)
			) {
				return throwParseError(
					writeNumberIndexMessage(key.expression, this.sequence.expression)
				)
			}
			return throwParseError(writeInvalidKeysMessage(this.expression, [key]))
		}

		const result = value.get(...path)
		return required ? result : result.or($ark.intrinsic.undefined)
	}

	pick(...keys: KeyOrKeyNode[]): StructureNode {
		this.assertHasKeys(keys)
		return this.$.node("structure", this.filterKeys("pick", keys))
	}

	omit(...keys: KeyOrKeyNode[]): StructureNode {
		this.assertHasKeys(keys)
		return this.$.node("structure", this.filterKeys("omit", keys))
	}

	optionalize(): StructureNode {
		const { required, ...inner } = this.inner
		return this.$.node("structure", {
			...inner,
			optional: this.props.map(prop =>
				prop.hasKind("required") ? this.$.node("optional", prop.inner) : prop
			)
		})
	}

	require(): StructureNode {
		const { optional, ...inner } = this.inner
		return this.$.node("structure", {
			...inner,
			required: this.props.map(prop =>
				prop.hasKind("optional") ?
					{
						key: prop.key,
						value: prop.value
					}
				:	prop
			)
		})
	}

	merge(r: StructureNode): StructureNode {
		const inner = this.filterKeys("omit", [r.keyof()])

		if (r.required) inner.required = append(inner.required, r.required)
		if (r.optional) inner.optional = append(inner.optional, r.optional)
		if (r.index) inner.index = append(inner.index, r.index)
		if (r.sequence) inner.sequence = r.sequence
		if (r.undeclared) inner.undeclared = r.undeclared
		else delete inner.undeclared
		return this.$.node("structure", inner)
	}

	private filterKeys(
		operation: "pick" | "omit",
		keys: array<BaseRoot | Key>
	): Structure.Inner.mutable {
		const result = makeRootAndArrayPropertiesMutable(this.inner)

		const shouldKeep = (key: KeyOrKeyNode) => {
			const matchesKey = keys.some(k => typeOrTermExtends(key, k))
			return operation === "pick" ? matchesKey : !matchesKey
		}

		if (result.required)
			result.required = result.required.filter(prop => shouldKeep(prop.key))

		if (result.optional)
			result.optional = result.optional.filter(prop => shouldKeep(prop.key))

		if (result.index)
			result.index = result.index.filter(index => shouldKeep(index.signature))

		return result
	}

	traverseAllows: TraverseAllows<object> = (data, ctx) =>
		this._traverse("Allows", data, ctx)

	traverseApply: TraverseApply<object> = (data, ctx) =>
		this._traverse("Apply", data, ctx)

	protected _traverse = (
		traversalKind: TraversalKind,
		data: object,
		ctx: InternalTraversal
	): boolean => {
		const errorCount = ctx?.currentErrorCount ?? 0
		for (let i = 0; i < this.props.length; i++) {
			if (traversalKind === "Allows") {
				if (!this.props[i].traverseAllows(data, ctx)) return false
			} else {
				this.props[i].traverseApply(data as never, ctx)
				if (ctx.failFast && ctx.currentErrorCount > errorCount) return false
			}
		}

		if (this.sequence) {
			if (traversalKind === "Allows") {
				if (!this.sequence.traverseAllows(data as never, ctx)) return false
			} else {
				this.sequence.traverseApply(data as never, ctx)
				if (ctx.failFast && ctx.currentErrorCount > errorCount) return false
			}
		}

		if (this.index || this.undeclared === "reject") {
			const keys: Key[] = Object.keys(data)
			keys.push(...Object.getOwnPropertySymbols(data))

			for (let i = 0; i < keys.length; i++) {
				const k = keys[i]

				if (this.index) {
					for (const node of this.index) {
						if (node.signature.traverseAllows(k, ctx)) {
							if (traversalKind === "Allows") {
								const result = traverseKey(
									k,
									() => node.value.traverseAllows(data[k as never], ctx),
									ctx
								)
								if (!result) return false
							} else {
								traverseKey(
									k,
									() => node.value.traverseApply(data[k as never], ctx),
									ctx
								)
								if (ctx.failFast && ctx.currentErrorCount > errorCount)
									return false
							}
						}
					}
				}

				if (this.undeclared === "reject" && !this.declaresKey(k)) {
					if (traversalKind === "Allows") return false

					// this should have its own error code:
					// https://github.com/arktypeio/arktype/issues/1403
					ctx.errorFromNodeContext({
						code: "predicate",
						expected: "removed",
						actual: "",
						relativePath: [k],
						meta: this.meta
					})

					if (ctx.failFast) return false
				}
			}
		}

		// added additional ctx check here to address
		// https://github.com/arktypeio/arktype/issues/1346
		if (this.structuralMorph && ctx && !ctx.hasError())
			ctx.queueMorphs([this.structuralMorph])

		return true
	}

	get defaultable(): Optional.Node.withDefault[] {
		return this.cacheGetter(
			"defaultable",
			this.optional?.filter(o => o.hasDefault()) ?? []
		)
	}

	declaresKey = (k: Key): boolean =>
		k in this.propsByKey ||
		this.index?.some(n => n.signature.allows(k)) ||
		(this.sequence !== undefined &&
			$ark.intrinsic.nonNegativeIntegerString.allows(k))

	_compileDeclaresKey(js: NodeCompiler): string {
		const parts: string[] = []
		if (this.props.length) parts.push(`k in ${this.propsByKeyReference}`)

		if (this.index) {
			for (const index of this.index)
				parts.push(js.invoke(index.signature, { kind: "Allows", arg: "k" }))
		}

		if (this.sequence)
			parts.push("$ark.intrinsic.nonNegativeIntegerString.allows(k)")

		// if parts is empty, this is a structure like { "+": "reject" }
		// that declares no keys, so return false
		return parts.join(" || ") || "false"
	}

	get structuralMorph(): Morph | undefined {
		return this.cacheGetter("structuralMorph", getPossibleMorph(this))
	}

	structuralMorphRef: RegisteredReference | undefined =
		this.structuralMorph && registeredReference(this.structuralMorph)

	compile(js: NodeCompiler): unknown {
		if (js.traversalKind === "Apply") js.initializeErrorCount()

		for (const prop of this.props) {
			js.check(prop)
			if (js.traversalKind === "Apply") js.returnIfFailFast()
		}

		if (this.sequence) {
			js.check(this.sequence)
			if (js.traversalKind === "Apply") js.returnIfFailFast()
		}

		if (this.index || this.undeclared === "reject") {
			js.const("keys", "Object.keys(data)")
			js.line("keys.push(...Object.getOwnPropertySymbols(data))")
			js.for("i < keys.length", () => this.compileExhaustiveEntry(js))
		}

		if (js.traversalKind === "Allows") return js.return(true)

		// always queue deleteUndeclared on valid traversal for "delete"
		if (this.structuralMorphRef) {
			// added additional ctx check here to address
			// https://github.com/arktypeio/arktype/issues/1346
			js.if("ctx && !ctx.hasError()", () => {
				js.line(`ctx.queueMorphs([`)
				precompileMorphs(js, this)
				return js.line("])")
			})
		}
	}

	protected compileExhaustiveEntry(js: NodeCompiler): NodeCompiler {
		js.const("k", "keys[i]")

		if (this.index) {
			for (const node of this.index) {
				js.if(
					`${js.invoke(node.signature, { arg: "k", kind: "Allows" })}`,
					() => js.traverseKey("k", "data[k]", node.value)
				)
			}
		}

		if (this.undeclared === "reject") {
			js.if(`!(${this._compileDeclaresKey(js)})`, () => {
				if (js.traversalKind === "Allows") return js.return(false)
				return js
					.line(
						`ctx.errorFromNodeContext({ code: "predicate", expected: "removed", actual: "", relativePath: [k], meta: ${this.compiledMeta} })`
					)
					.if("ctx.failFast", () => js.return())
			})
		}

		return js
	}

	reduceJsonSchema(
		schema: JsonSchema.Structure,
		ctx: ToJsonSchema.Context
	): JsonSchema.Structure {
		switch (schema.type) {
			case "object":
				return this.reduceObjectJsonSchema(schema, ctx)
			case "array":
				const arraySchema =
					this.sequence?.reduceJsonSchema(schema, ctx) ?? schema
				if (this.props.length || this.index) {
					return ctx.fallback.arrayObject({
						code: "arrayObject",
						base: arraySchema,
						object: this.reduceObjectJsonSchema({ type: "object" }, ctx)
					})
				}

				return arraySchema

			default:
				return ToJsonSchema.throwInternalOperandError("structure", schema)
		}
	}

	reduceObjectJsonSchema(
		schema: JsonSchema.Object,
		ctx: ToJsonSchema.Context
	): JsonSchema.Object {
		if (this.props.length) {
			schema.properties = {}
			for (const prop of this.props) {
				const valueSchema = prop.value.toJsonSchemaRecurse(ctx)

				if (typeof prop.key === "symbol") {
					ctx.fallback.symbolKey({
						code: "symbolKey",
						base: schema,
						key: prop.key,
						value: valueSchema,
						optional: prop.optional
					})
					continue
				}

				if (prop.hasDefault()) {
					const value =
						typeof prop.default === "function" ? prop.default() : prop.default
					valueSchema.default =
						$ark.intrinsic.jsonData.allows(value) ?
							value
						:	ctx.fallback.defaultValue({
								code: "defaultValue",
								base: valueSchema,
								value
							})
				}

				schema.properties![prop.key] = valueSchema
			}
			if (this.requiredKeys.length && schema.properties) {
				schema.required = this.requiredKeys.filter(
					(k): k is string => typeof k === "string" && k in schema.properties!
				)
			}
		}

		if (this.index) {
			for (const index of this.index) {
				const valueJsonSchema = index.value.toJsonSchemaRecurse(ctx)

				if (index.signature.equals($ark.intrinsic.string)) {
					schema.additionalProperties = valueJsonSchema
					continue
				}

				for (const keyBranch of index.signature.branches) {
					if (!keyBranch.extends($ark.intrinsic.string)) {
						schema = ctx.fallback.symbolKey({
							code: "symbolKey",
							base: schema,
							key: null,
							value: valueJsonSchema,
							optional: false
						})

						continue
					}

					let keySchema: JsonSchema.String = { type: "string" }
					if (keyBranch.hasKind("morph")) {
						keySchema = ctx.fallback.morph({
							code: "morph",
							base: keyBranch.in.toJsonSchemaRecurse(ctx),
							out: keyBranch.out.toJsonSchemaRecurse(ctx)
						}) as never
					}
					if (!keyBranch.hasKind("intersection")) {
						return throwInternalError(
							`Unexpected index branch kind ${keyBranch.kind}.`
						)
					}

					const { pattern } = keyBranch.inner

					if (pattern) {
						const keySchemaWithPattern = Object.assign(keySchema, {
							pattern: pattern[0].rule
						})

						for (let i = 1; i < pattern.length; i++) {
							keySchema = ctx.fallback.patternIntersection({
								code: "patternIntersection",
								base: keySchemaWithPattern,
								pattern: pattern[i].rule
							})
						}

						schema.patternProperties ??= {}
						schema.patternProperties[keySchemaWithPattern.pattern] =
							valueJsonSchema
					}
				}
			}
		}

		if (this.undeclared && !schema.additionalProperties)
			schema.additionalProperties = false

		return schema
	}
}

const defaultableMorphsCache: Record<string, Morph | undefined> = {}

type PartiallyInitializedStructure = attachmentsOf<Structure.Declaration> &
	Pick<Structure.Node, "defaultable" | "declaresKey">

const constructStructuralMorphCacheKey = (
	node: PartiallyInitializedStructure
): string => {
	let cacheKey = ""

	for (let i = 0; i < node.defaultable.length; i++)
		cacheKey += node.defaultable[i].defaultValueMorphRef

	if (node.sequence?.defaultValueMorphsReference)
		cacheKey += node.sequence?.defaultValueMorphsReference

	if (node.undeclared === "delete") {
		cacheKey += "delete !("
		if (node.required)
			for (const n of node.required) cacheKey += n.compiledKey + " | "
		if (node.optional)
			for (const n of node.optional) cacheKey += n.compiledKey + " | "
		if (node.index)
			for (const index of node.index) cacheKey += index.signature.id + " | "
		if (node.sequence) {
			if (node.sequence.maxLength === null)
				cacheKey += intrinsic.nonNegativeIntegerString.id
			else {
				for (let i = 0; i < node.sequence.tuple.length; i++)
					cacheKey += i + " | "
			}
		}
		cacheKey += ")"
	}

	return cacheKey
}

const getPossibleMorph = (
	node: PartiallyInitializedStructure
): Morph | undefined => {
	const cacheKey = constructStructuralMorphCacheKey(node)
	if (!cacheKey) return undefined

	if (defaultableMorphsCache[cacheKey]) return defaultableMorphsCache[cacheKey]

	const $arkStructuralMorph: Morph = (data, ctx) => {
		for (let i = 0; i < node.defaultable.length; i++) {
			if (!(node.defaultable[i].key in data))
				node.defaultable[i].defaultValueMorph(data, ctx)
		}

		if (node.sequence?.defaultables) {
			for (
				let i = data.length - node.sequence.prefixLength;
				i < node.sequence.defaultables.length;
				i++
			)
				node.sequence.defaultValueMorphs[i](data, ctx)
		}

		if (node.undeclared === "delete")
			for (const k in data) if (!node.declaresKey(k)) delete (data as dict)[k]

		return data
	}

	return (defaultableMorphsCache[cacheKey] = $arkStructuralMorph)
}

const precompileMorphs = (js: NodeCompiler, node: Structure.Node) => {
	const requiresContext =
		node.defaultable.some(node => node.defaultValueMorph.length === 2) ||
		node.sequence?.defaultValueMorphs.some(morph => morph.length === 2)

	const args = `(data${requiresContext ? ", ctx" : ""})`

	return js.block(`${args} => `, js => {
		for (let i = 0; i < node.defaultable.length; i++) {
			const { serializedKey, defaultValueMorphRef } = node.defaultable[i]
			js.if(`!(${serializedKey} in data)`, js =>
				js.line(`${defaultValueMorphRef}${args}`)
			)
		}

		if (node.sequence?.defaultables) {
			js.for(
				`i < ${node.sequence.defaultables.length}`,
				js => js.set(`data[i]`, 5),
				`data.length - ${node.sequence.prefixLength}`
			)
		}

		if (node.undeclared === "delete") {
			js.forIn("data", js =>
				js.if(`!(${node._compileDeclaresKey(js)})`, js =>
					js.line(`delete data[k]`)
				)
			)
		}

		return js.return("data")
	})
}

export type PropFlatMapper = (entry: Prop.Node) => listable<MappedPropInner>

export type MappedPropInner = BaseMappedPropInner | OptionalMappedPropInner

// this assumes the props on Required.Inner are a subset of those on Optional.Inner
export interface BaseMappedPropInner extends Required.Schema {
	kind?: "required" | "optional"
}

export interface OptionalMappedPropInner extends Optional.Schema {
	kind: "optional"
}

export const Structure = {
	implementation,
	Node: StructureNode
}

const indexerToKey = (indexable: GettableKeyOrNode): KeyOrKeyNode => {
	if (hasArkKind(indexable, "root") && indexable.hasKind("unit"))
		indexable = indexable.unit as Key
	if (typeof indexable === "number") indexable = `${indexable}`
	return indexable
}

export const writeNumberIndexMessage = (
	indexExpression: string,
	sequenceExpression: string
): string =>
	`${indexExpression} is not allowed as an array index on ${sequenceExpression}. Use the 'nonNegativeIntegerString' keyword instead.`

export type NormalizedIndex = {
	index?: Index.Node
	required?: Required.Node[]
	optional?: Optional.Node[]
}

/** extract enumerable named props from an index signature */
export const normalizeIndex = (
	signature: BaseRoot,
	value: BaseRoot,
	$: BaseScope
): NormalizedIndex => {
	const [enumerableBranches, nonEnumerableBranches] = spliterate(
		signature.branches,
		k => k.hasKind("unit")
	)

	if (!enumerableBranches.length)
		return { index: $.node("index", { signature, value }) }

	const normalized: NormalizedIndex = {}

	for (const n of enumerableBranches) {
		// since required can be reduced to optional if it has a default or
		// optional meta on its value, we have to assign it depending on the
		// compiled kind
		const prop = $.node("required", { key: n.unit as Key, value })
		normalized[prop.kind] = append(normalized[prop.kind], prop as never)
	}

	if (nonEnumerableBranches.length) {
		normalized.index = $.node("index", {
			signature: nonEnumerableBranches,
			value
		})
	}

	return normalized
}

export const typeKeyToString = (k: KeyOrKeyNode): string =>
	hasArkKind(k, "root") ? k.expression : printable(k)

export const writeInvalidKeysMessage = <
	o extends string,
	keys extends array<KeyOrKeyNode>
>(
	o: o,
	keys: keys
): string =>
	`Key${keys.length === 1 ? "" : "s"} ${keys.map(typeKeyToString).join(", ")} ${keys.length === 1 ? "does" : "do"} not exist on ${o}`
