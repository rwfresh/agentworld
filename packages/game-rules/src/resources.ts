import { type ResourceAmount, resourceAmount } from "./types.ts";

export type ResourceKind = "energy" | "materials" | "inference";

export interface ResourceVector {
  readonly energy: ResourceAmount;
  readonly materials: ResourceAmount;
  readonly inference: ResourceAmount;
}

export interface Inventory {
  /** Starter grants are spent first and can never be traded. */
  readonly bound: ResourceVector;
  readonly transferable: ResourceVector;
}

export interface ResourceDebit {
  readonly inventory: Inventory;
  readonly spentBound: ResourceVector;
  readonly spentTransferable: ResourceVector;
}

export const resources = (energy = 0, materials = 0, inference = 0): ResourceVector => ({
  energy: resourceAmount(energy),
  materials: resourceAmount(materials),
  inference: resourceAmount(inference),
});

export const emptyResources = (): ResourceVector => resources();

function checkedSum(left: number, right: number): ResourceAmount {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("resource arithmetic exceeded safe integer bounds");
  }
  return resourceAmount(value);
}

export function addResources(left: ResourceVector, right: ResourceVector): ResourceVector {
  return {
    energy: checkedSum(left.energy, right.energy),
    materials: checkedSum(left.materials, right.materials),
    inference: checkedSum(left.inference, right.inference),
  };
}

export function multiplyResources(vector: ResourceVector, multiplier: number): ResourceVector {
  if (!Number.isSafeInteger(multiplier) || multiplier < 0) {
    throw new RangeError("resource multiplier must be a non-negative safe integer");
  }
  return resources(
    vector.energy * multiplier,
    vector.materials * multiplier,
    vector.inference * multiplier,
  );
}

export function inventoryTotal(inventory: Inventory): ResourceVector {
  return addResources(inventory.bound, inventory.transferable);
}

export function canAfford(inventory: Inventory, cost: ResourceVector): boolean {
  const total = inventoryTotal(inventory);
  return (
    total.energy >= cost.energy &&
    total.materials >= cost.materials &&
    total.inference >= cost.inference
  );
}

function debitKind(
  bound: ResourceAmount,
  transferable: ResourceAmount,
  cost: ResourceAmount,
): readonly [ResourceAmount, ResourceAmount, ResourceAmount, ResourceAmount] {
  const fromBound = resourceAmount(Math.min(bound, cost));
  const remainder = cost - fromBound;
  const fromTransferable = resourceAmount(remainder);
  return [
    resourceAmount(bound - fromBound),
    resourceAmount(transferable - fromTransferable),
    fromBound,
    fromTransferable,
  ];
}

/** Debits bound resources first. Callers must check affordability. */
export function debitResources(inventory: Inventory, cost: ResourceVector): ResourceDebit {
  if (!canAfford(inventory, cost)) {
    throw new RangeError("insufficient resources");
  }
  const energy = debitKind(inventory.bound.energy, inventory.transferable.energy, cost.energy);
  const materials = debitKind(
    inventory.bound.materials,
    inventory.transferable.materials,
    cost.materials,
  );
  const inference = debitKind(
    inventory.bound.inference,
    inventory.transferable.inference,
    cost.inference,
  );
  return {
    inventory: {
      bound: resources(energy[0], materials[0], inference[0]),
      transferable: resources(energy[1], materials[1], inference[1]),
    },
    spentBound: resources(energy[2], materials[2], inference[2]),
    spentTransferable: resources(energy[3], materials[3], inference[3]),
  };
}

export function creditTransferable(inventory: Inventory, credit: ResourceVector): Inventory {
  return {
    bound: inventory.bound,
    transferable: addResources(inventory.transferable, credit),
  };
}

export function resourceForKind(kind: ResourceKind, amount: number): ResourceVector {
  switch (kind) {
    case "energy":
      return resources(amount, 0, 0);
    case "materials":
      return resources(0, amount, 0);
    case "inference":
      return resources(0, 0, amount);
  }
}
