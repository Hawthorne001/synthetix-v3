import path from 'node:path';
import { parseFullyQualifiedName } from 'hardhat/utils/contract-names';
import { ElementaryTypeName, SourceUnit, TypeName } from 'solidity-ast';
import { findAll } from 'solidity-ast/utils';
import { renderTemplate } from '../internal/render-template';

interface TestableStorageTemplateInputs {
  sourceFile: string;
  libraryName: string;

  loadParams?: string;
  loadInject?: string;

  fields: {
    name: string;
    type: string;
  }[];

  indexedFields: {
    name: string;
    type: string;
    indexType: string;
    isArray: boolean;
  }[];

  methods: {
    name: string;
    mutability?: string;
    usesLoad: boolean;
    params: string;
    paramsInject: string;
    returns: string;
  }[];
}

export function renderTestableStorage({
  artifact,
  sourceAstNode,
  template = path.resolve(__dirname, '..', '..', 'templates', 'TestableStorage.sol.mustache'),
}: {
  artifact: string;
  sourceAstNode: SourceUnit;
  template?: string;
}) {
  const { sourceName, contractName } = parseFullyQualifiedName(artifact);
  const input = _generateTemplateInputs(sourceName, contractName, sourceAstNode);
  return renderTemplate(template, input as unknown as { [k: string]: unknown });
}

function _generateTemplateInputs(sourceFile: string, contractName: string, astNode: SourceUnit) {
  const contractDefinition = _findContractNode(contractName, astNode);

  const dataStructDefinition = Array.from(findAll('StructDefinition', contractDefinition)).find(
    (def) => def.name === 'Data'
  );

  if (!dataStructDefinition) {
    throw new Error(`Storage contract in "${sourceFile}" needs a struct named "Data" to render`);
  }

  const fields: TestableStorageTemplateInputs['fields'] = [];
  const indexedFields: TestableStorageTemplateInputs['indexedFields'] = [];
  for (const variableDeclaration of dataStructDefinition.members) {
    if (variableDeclaration.typeName?.nodeType === 'Mapping') {
      if (variableDeclaration.typeName.valueType.nodeType !== 'ElementaryTypeName') {
        console.log(
          `Skipping generated getter/setter for ${variableDeclaration.name} because it has a nested type`
        );
        continue;
      }

      indexedFields.push({
        name: variableDeclaration.name,
        type: variableDeclaration.typeName.valueType.name!,
        indexType: (variableDeclaration.typeName.keyType as ElementaryTypeName).name,
        isArray: false,
      });
    } else if (variableDeclaration.typeName?.nodeType === 'ArrayTypeName') {
      if (variableDeclaration.typeName.baseType.nodeType !== 'ElementaryTypeName') {
        console.log(
          `Skipping generated getter/setter for ${variableDeclaration.name} because it has a nested type`
        );
        continue;
      }

      indexedFields.push({
        name: variableDeclaration.name,
        type: variableDeclaration.typeName.baseType.name!,
        indexType: 'uint',
        isArray: false,
      });
    } else if (variableDeclaration.typeName?.nodeType === 'ElementaryTypeName') {
      fields.push({
        name: variableDeclaration.name,
        type:
          (variableDeclaration.typeName! as ElementaryTypeName).name === 'string' ||
          variableDeclaration.typeName.name === 'bytes'
            ? `${variableDeclaration.typeName.name} memory`
            : variableDeclaration.typeName.name,
      });
    }
    // else, don't know what to do about nested types atm
  }

  const methods: TestableStorageTemplateInputs['methods'] = [];
  let loadParams: TestableStorageTemplateInputs['loadParams'] = undefined;
  let loadInject: TestableStorageTemplateInputs['loadInject'] = undefined;

  for (const functionDefinition of findAll('FunctionDefinition', contractDefinition)) {
    if (functionDefinition.visibility === 'private') {
      console.log(`Skipping function ${functionDefinition.name} because its private`);
      continue;
    }

    if (functionDefinition.name === 'load') {
      loadParams = functionDefinition.parameters.parameters
        .map(
          (p) =>
            `${_renderAstType(p.typeName!)}${
              p.storageLocation !== 'default' ? ' ' + p.storageLocation : ''
            } _load_${p.name}`
        )
        .join(', ');

      loadInject = functionDefinition.parameters.parameters
        .map((p) => '_load_' + p.name)
        .join(', ');

      continue; // we have handled the load function
    }

    if (
      functionDefinition.returnParameters.parameters.filter((p) => p.storageLocation === 'storage')
        .length
    ) {
      console.log(
        `Skipping function ${functionDefinition.name} because it returns an unsupported storage input parameter`
      );
      continue; // cannot return non-storage
    }

    const storageParams = functionDefinition.parameters.parameters.filter(
      (p) => p.storageLocation === 'storage'
    );

    if (storageParams.length > 1) {
      console.log(
        `Skipping function ${functionDefinition.name} because it contains unsupported storage input parameter type`
      );
      continue; // input parameter must be of the same type as the contract
    }

    methods.push({
      name: functionDefinition.name,
      mutability:
        functionDefinition.stateMutability === 'view' ||
        functionDefinition.stateMutability === 'pure'
          ? functionDefinition.stateMutability
          : undefined,
      usesLoad: storageParams.length > 0,
      params: functionDefinition.parameters.parameters
        .filter((p) => p.storageLocation !== 'storage') // only non-storage values can be injected (storage values will be injected later)
        .map(
          (p) =>
            `${_renderAstType(p.typeName!)}${
              p.storageLocation !== 'default' ? ' ' + p.storageLocation : ''
            } ${p.name}`
        )
        .join(', '),
      paramsInject: functionDefinition.parameters.parameters
        .map((p) => (p.storageLocation === 'storage' ? 'store' : p.name))
        .join(', '),
      returns: functionDefinition.returnParameters.parameters
        .map(
          (p) =>
            `${_renderAstType(p.typeName!)}${
              p.storageLocation !== 'default' ? ' ' + p.storageLocation : ''
            }`
        )
        .join(', '),
    });
  }

  const input: TestableStorageTemplateInputs = {
    sourceFile,
    loadParams,
    loadInject,
    libraryName: contractDefinition.name,
    fields,
    indexedFields,
    methods,
  };

  return input;
}

function _findContractNode(contractName: string, astNode: SourceUnit) {
  for (const contractDefiniton of findAll('ContractDefinition', astNode)) {
    if (contractDefiniton.name === contractName) {
      return contractDefiniton;
    }
  }

  throw new Error(`Contract node for "${contractName}" not found`);
}

function _renderAstType(t: TypeName): string {
  if (t.nodeType === 'Mapping') {
    return `mapping(${_renderAstType(t.keyType)} => ${_renderAstType(t.valueType)})`;
  } else if (t.nodeType === 'ArrayTypeName') {
    return `${_renderAstType(t.baseType)}[${t.length || ''}]`;
  } else if (t.nodeType === 'FunctionTypeName') {
    return 'function'; // dont know what to do with this
  } else {
    return t.name || '';
  }
}