import test from "node:test";
import assert from "node:assert/strict";
import { GraphStore } from "../src/graph/graphStore.js";
import { indexCppFile } from "../src/indexers/cppIndexer.js";

test("cppIndexer can find UCLASS, UFUNCTION, and UPROPERTY", () => {
  const store = new GraphStore();
  indexCppFile(
    {
      relativePath: "Source/Test/Public/MyActor.h",
      system: "Test",
      content: `
#pragma once
#include "CoreMinimal.h"

UCLASS(BlueprintType)
class TEST_API AMyActor : public AActor
{
  GENERATED_BODY()

public:
  UPROPERTY(EditAnywhere)
  float Speed = 1.0f;

  UFUNCTION(BlueprintCallable)
  void StartCar();
};
`
    },
    store
  );

  const nodes = store.nodes();
  assert.ok(nodes.some((node) => node.type === "Class" && node.name === "AMyActor"));
  assert.ok(nodes.some((node) => node.type === "Function" && node.name === "StartCar"));
  assert.ok(nodes.some((node) => node.type === "Property" && node.name === "Speed"));
  assert.ok(store.edges().some((edge) => edge.type === "INCLUDES"));
});
