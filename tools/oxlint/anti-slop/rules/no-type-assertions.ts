import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

export const noTypeAssertionsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow type assertions except const assertions.",
    },
    messages: {
      unsafeAssertion:
        "Narrow the value with a runtime check or give its producer an accurate return type.",
    },
  },
  createOnce(context) {
    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node)) return;
      context.report({ node, messageId: "unsafeAssertion" });
    };

    return {
      TSAsExpression: checkAssertion,
      TSTypeAssertion: checkAssertion,
    };
  },
});
