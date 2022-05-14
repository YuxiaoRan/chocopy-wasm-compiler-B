import * as AST from './ast';
import * as IR from './ir';
import { Type, SourceLocation } from './ast';
import { GlobalEnv } from './compiler';

const nameCounters : Map<string, number> = new Map();
function generateName(base : string) : string {
  if(nameCounters.has(base)) {
    var cur = nameCounters.get(base);
    nameCounters.set(base, cur + 1);
    return base + (cur + 1);
  }
  else {
    nameCounters.set(base, 1);
    return base + 1;
  }
}

// function lbl(a: Type, base: string) : [string, IR.Stmt<[Type, SourceLocation]>] {
//   const name = generateName(base);
//   return [name, {tag: "label", a: a, name: name}];
// }

export function lowerProgram(p : AST.Program<[Type, SourceLocation]>, env : GlobalEnv) : IR.Program<[Type, SourceLocation]> {
    var blocks : Array<IR.BasicBlock<[Type, SourceLocation]>> = [];
    var firstBlock : IR.BasicBlock<[Type, SourceLocation]> = {  a: p.a, label: generateName("$startProg"), stmts: [] }
    blocks.push(firstBlock);
    var inits = flattenStmts(p.stmts, blocks, env);
    return {
        a: p.a,
        funs: lowerFunDefs(p.funs, env),
        inits: [...inits, ...lowerVarInits(p.inits, env)],
        classes: lowerClasses(p.classes, env),
        body: blocks
    }
}

function lowerFunDefs(fs : Array<AST.FunDef<[Type, SourceLocation]>>, env : GlobalEnv) : Array<IR.FunDef<[Type, SourceLocation]>> {
    return fs.map(f => lowerFunDef(f, env)).flat();
}

function lowerFunDef(f : AST.FunDef<[Type, SourceLocation]>, env : GlobalEnv) : IR.FunDef<[Type, SourceLocation]> {
  var blocks : Array<IR.BasicBlock<[Type, SourceLocation]>> = [];
  var firstBlock : IR.BasicBlock<[Type, SourceLocation]> = {  a: f.a, label: generateName("$startFun"), stmts: [] }
  blocks.push(firstBlock);
  var bodyinits = flattenStmts(f.body, blocks, env);
    return {...f, inits: [...bodyinits, ...lowerVarInits(f.inits, env)], body: blocks}
}

function lowerVarInits(inits: Array<AST.VarInit<[Type, SourceLocation]>>, env: GlobalEnv) : Array<IR.VarInit<[Type, SourceLocation]>> {
    return inits.map(i => lowerVarInit(i, env));
}

function lowerVarInit(init: AST.VarInit<[Type, SourceLocation]>, env: GlobalEnv) : IR.VarInit<[Type, SourceLocation]> {
    return {
        ...init,
        value: literalToVal(init.value)
    }
}

function lowerClasses(classes: Array<AST.Class<[Type, SourceLocation]>>, env : GlobalEnv) : Array<IR.Class<[Type, SourceLocation]>> {
    return classes.map(c => lowerClass(c, env));
}

function lowerClass(cls: AST.Class<[Type, SourceLocation]>, env : GlobalEnv) : IR.Class<[Type, SourceLocation]> {
    return {
        ...cls,
        fields: lowerVarInits(cls.fields, env),
        methods: lowerFunDefs(cls.methods, env)
    }
}

function literalToVal(lit: AST.Literal) : IR.Value<[Type, SourceLocation]> {
    switch(lit.tag) {
        case "num":
            return { ...lit, value: BigInt(lit.value) }
        case "bool":
            return lit
        case "none":
            return lit        
    }
}

function flattenStmts(s : Array<AST.Stmt<[Type, SourceLocation]>>, blocks: Array<IR.BasicBlock<[Type, SourceLocation]>>, env : GlobalEnv) : Array<IR.VarInit<[Type, SourceLocation]>> {
  var inits: Array<IR.VarInit<[Type, SourceLocation]>> = [];
  s.forEach(stmt => {
    inits.push(...flattenStmt(stmt, blocks, env));
  });
  return inits;
}

function flattenStmt(s : AST.Stmt<[Type, SourceLocation]>, blocks: Array<IR.BasicBlock<[Type, SourceLocation]>>, env : GlobalEnv) : Array<IR.VarInit<[Type, SourceLocation]>> {
  switch(s.tag) {
    case "assign":
      var [valinits, valstmts, vale] = flattenExprToExpr(s.value, blocks, env);
      blocks[blocks.length - 1].stmts.push(...valstmts, { a: s.a, tag: "assign", name: s.name, value: vale});
      return valinits
      // return [valinits, [
      //   ...valstmts,
      //   { a: s.a, tag: "assign", name: s.name, value: vale}
      // ]];

    case "return":
    var [valinits, valstmts, val] = flattenExprToVal(s.value, env);
    blocks[blocks.length - 1].stmts.push(
         ...valstmts,
         {tag: "return", a: s.a, value: val}
    );
    return valinits;
    // return [valinits, [
    //     ...valstmts,
    //     {tag: "return", a: s.a, value: val}
    // ]];
  
    case "expr":
      var [inits, stmts, e] = flattenExprToExpr(s.expr, blocks, env);
      blocks[blocks.length - 1].stmts.push(
        ...stmts, {tag: "expr", a: s.a, expr: e }
      );
      return inits;
    //  return [inits, [ ...stmts, {tag: "expr", a: s.a, expr: e } ]];

    case "pass":
      return [];

    case "field-assign": {
      var [oinits, ostmts, oval] = flattenExprToVal(s.obj, env);
      var [ninits, nstmts, nval] = flattenExprToVal(s.value, env);
      if(s.obj.a[0].tag !== "class") { throw new Error("Compiler's cursed, go home."); }
      const classdata = env.classes.get(s.obj.a[0].name);
      const offset : IR.Value<[Type, SourceLocation]> = { tag: "wasmint", value: classdata.get(s.field)[0] };
      pushStmtsToLastBlock(blocks,
        ...ostmts, ...nstmts, {
          tag: "store",
          a: s.a,
          start: oval,
          offset: offset,
          value: nval
        });
      return [...oinits, ...ninits];
    }
      // return [[...oinits, ...ninits], [...ostmts, ...nstmts, {
      //   tag: "field-assign",
      //   a: s.a,
      //   obj: oval,
      //   field: s.field,
      //   value: nval
      // }]];

    case "if":
      var thenLbl = generateName("$then")
      var elseLbl = generateName("$else")
      var endLbl = generateName("$end")
      var endjmp : IR.Stmt<[Type, SourceLocation]> = { tag: "jmp", lbl: endLbl };
      var [cinits, cstmts, cexpr] = flattenExprToVal(s.cond, env);
      var condjmp : IR.Stmt<[Type, SourceLocation]> = { tag: "ifjmp", cond: cexpr, thn: thenLbl, els: elseLbl };
      pushStmtsToLastBlock(blocks, ...cstmts, condjmp);
      blocks.push({  a: s.a, label: thenLbl, stmts: [] })
      var theninits = flattenStmts(s.thn, blocks, env);
      pushStmtsToLastBlock(blocks, endjmp);
      blocks.push({  a: s.a, label: elseLbl, stmts: [] })
      var elseinits = flattenStmts(s.els, blocks, env);
      pushStmtsToLastBlock(blocks, endjmp);
      blocks.push({  a: s.a, label: endLbl, stmts: [] })
      return [...cinits, ...theninits, ...elseinits]

      // return [[...cinits, ...theninits, ...elseinits], [
      //   ...cstmts, 
      //   condjmp,
      //   startlbl,
      //   ...thenstmts,
      //   endjmp,
      //   elslbl,
      //   ...elsestmts,
      //   endjmp,
      //   endlbl,
      // ]];
    
    case "while":
      var whileStartLbl = generateName("$whilestart");
      var whilebodyLbl = generateName("$whilebody");
      var whileEndLbl = generateName("$whileend");

      pushStmtsToLastBlock(blocks, { tag: "jmp", lbl: whileStartLbl })
      blocks.push({  a: s.a, label: whileStartLbl, stmts: [] })
      var [cinits, cstmts, cexpr] = flattenExprToVal(s.cond, env);
      pushStmtsToLastBlock(blocks, ...cstmts, { tag: "ifjmp", cond: cexpr, thn: whilebodyLbl, els: whileEndLbl });

      blocks.push({  a: s.a, label: whilebodyLbl, stmts: [] })
      var bodyinits = flattenStmts(s.body, blocks, env);
      pushStmtsToLastBlock(blocks, { tag: "jmp", lbl: whileStartLbl });

      blocks.push({  a: s.a, label: whileEndLbl, stmts: [] })

      return [...cinits, ...bodyinits]
  }
}

function flattenExprToExpr(e : AST.Expr<[Type, SourceLocation]>, blocks: Array<IR.BasicBlock<[Type, SourceLocation]>>, env : GlobalEnv) : [Array<IR.VarInit<[Type, SourceLocation]>>, Array<IR.Stmt<[Type, SourceLocation]>>, IR.Expr<[Type, SourceLocation]>] {
  switch(e.tag) {
    case "uniop":
      var [inits, stmts, val] = flattenExprToVal(e.expr, env);
      return [inits, stmts, {
        ...e,
        expr: val
      }];
    case "binop":
      var [linits, lstmts, lval] = flattenExprToVal(e.left, env);
      var [rinits, rstmts, rval] = flattenExprToVal(e.right, env);
      return [[...linits, ...rinits], [...lstmts, ...rstmts], {
          ...e,
          left: lval,
          right: rval
        }];
    case "builtin1":
      var [inits, stmts, val] = flattenExprToVal(e.arg, env);
      return [inits, stmts, {tag: "builtin1", a: e.a, name: e.name, arg: val}];
    case "builtin2":
      var [linits, lstmts, lval] = flattenExprToVal(e.left, env);
      var [rinits, rstmts, rval] = flattenExprToVal(e.right, env);
      return [[...linits, ...rinits], [...lstmts, ...rstmts], {
          ...e,
          left: lval,
          right: rval
        }];
    case "call":
      const callpairs = e.arguments.map(a => flattenExprToVal(a, env));
      const callinits = callpairs.map(cp => cp[0]).flat();
      const callstmts = callpairs.map(cp => cp[1]).flat();
      const callvals = callpairs.map(cp => cp[2]).flat();
      return [ callinits, callstmts,
        {
          ...e,
          arguments: callvals
        }
      ];
    case "method-call": {
      const [objinits, objstmts, objval] = flattenExprToVal(e.obj, env);
      const argpairs = e.arguments.map(a => flattenExprToVal(a, env));
      const arginits = argpairs.map(cp => cp[0]).flat();
      const argstmts = argpairs.map(cp => cp[1]).flat();
      const argvals = argpairs.map(cp => cp[2]).flat();
      var objTyp = e.obj.a[0];
      if(objTyp.tag !== "class") { // I don't think this error can happen
        throw new Error("Report this as a bug to the compiler developer, this shouldn't happen " + objTyp.tag);
      }
      const className = objTyp.name;
      const checkObj : IR.Stmt<[Type, SourceLocation]> = { tag: "expr", expr: { tag: "call", name: `assert_not_none`, arguments: [objval]}}
      const callMethod : IR.Expr<[Type, SourceLocation]> = { tag: "call", name: `${className}$${e.method}`, arguments: [objval, ...argvals] }
      return [
        [...objinits, ...arginits],
        [...objstmts, checkObj, ...argstmts],
        callMethod
      ];
    }
    case "lookup": {
      const [oinits, ostmts, oval] = flattenExprToVal(e.obj, env);
      if(e.obj.a[0].tag !== "class") { throw new Error("Compiler's cursed, go home"); }
      const classdata = env.classes.get(e.obj.a[0].name);
      const [offset, _] = classdata.get(e.field);
      return [oinits, ostmts, {
        tag: "load",
        start: oval,
        offset: { tag: "wasmint", value: offset }}];
    }
    case "construct":
      const classdata = env.classes.get(e.name);
      const fields = [...classdata.entries()];
      const newName = generateName("newObj");
      const alloc : IR.Expr<[Type, SourceLocation]> = { tag: "alloc", amount: { tag: "wasmint", value: fields.length } };
      const assigns : IR.Stmt<[Type, SourceLocation]>[] = fields.map(f => {
        const [_, [index, value]] = f;
        return {
          tag: "store",
          start: { tag: "id", name: newName },
          offset: { tag: "wasmint", value: index },
          value: value
        }
      });

      return [
        [ { name: newName, type: e.a[0], value: { tag: "none" } }],
        [ { tag: "assign", name: newName, value: alloc }, ...assigns,
          { tag: "expr", expr: { tag: "call", name: `${e.name}$__init__`, arguments: [{ a: e.a, tag: "id", name: newName }] } }
        ],
        { a: e.a, tag: "value", value: { a: e.a, tag: "id", name: newName } }
      ];
    case "id":
      return [[], [], {tag: "value", value: { ...e }} ];
    case "literal":
      return [[], [], {tag: "value", value: literalToVal(e.value) } ];
    case "ternary":
    case "comprehension":
      return flattenExprToExprWithBlocks(e, blocks, env);
  }
}

function flattenExprToExprWithBlocks(e : AST.Expr<[Type, SourceLocation]>, blocks: Array<IR.BasicBlock<[Type, SourceLocation]>>, env : GlobalEnv) : [Array<IR.VarInit<[Type, SourceLocation]>>, Array<IR.Stmt<[Type, SourceLocation]>>, IR.Expr<[Type, SourceLocation]>] {
  switch(e.tag) {
    case "ternary":
      var [tinits, tstmts, tval] = flattenExprToVal(e.exprIfTrue, env);
      var [finits, fstmts, fval] = flattenExprToVal(e.exprIfFalse, env);
      var [condinits, condstmts, condval] = flattenExprToVal(e.ifcond, env);

      const resultName = generateName("resultVal");
      const resultInit : IR.VarInit<[Type, SourceLocation]> = { name: resultName, type: e.a[0], value: { tag: "none" } };

      var thenLbl = generateName("$then");
      var elseLbl = generateName("$else");
      var endLbl = generateName("$end");

      const condjmp : IR.Stmt<[Type, SourceLocation]> = { tag: "ifjmp", cond: condval, thn: thenLbl, els: elseLbl };
      const endjmp : IR.Stmt<[Type, SourceLocation]> = { tag: "jmp", lbl: endLbl };

      const assignTrue : IR.Stmt<[Type, SourceLocation]> = { tag: "assign", name: resultName, value: { tag: "value", value: tval } };
      const assignFalse : IR.Stmt<[Type, SourceLocation]> = { tag: "assign", name: resultName, value: { tag: "value", value: fval } };

      pushStmtsToLastBlock(blocks, ...tstmts, ...condstmts, ...fstmts)
      pushStmtsToLastBlock(blocks, condjmp);
      blocks.push({ a: e.a, label: thenLbl, stmts: [assignTrue] });
      pushStmtsToLastBlock(blocks, endjmp);
      blocks.push({ a: e.a, label: elseLbl, stmts: [assignFalse] });
      pushStmtsToLastBlock(blocks, endjmp);
      blocks.push({ a: e.a, label: endLbl, stmts: [] });

      return [[...tinits, ...condinits, ...finits, resultInit],
        [],
        { a: e.a, tag: "value", value: { a: e.a, tag: "id", name: resultName } }
      ];
    case "comprehension":
      // (lhsexpr for item in iterableexpr if condexpr)
      // obtain the iterable obj
      const [objinits, objstmts, objval] = flattenExprToVal(e.iterable, env);
      var objTyp = e.iterable.a[0];
      if(objTyp.tag !== "class") { // I don't think this error can happen
        throw new Error("Report this as a bug to the compiler developer, this shouldn't happen " + objTyp.tag);
      }
      const objClassName = objTyp.name;
      const checkObj : IR.Stmt<[Type, SourceLocation]> = { tag: "expr", expr: { tag: "call", name: `assert_not_none`, arguments: [objval]}};
      // method calls
      const callHasnext : IR.Expr<[Type, SourceLocation]> = { tag: "call", name: `${objClassName}$hasnext`, arguments: [objval] };
      const callNext : IR.Expr<[Type, SourceLocation]> = { tag: "call", name: `${objClassName}$next`, arguments: [objval] }

      const whileStartLbl = generateName("$whilestart");
      const whilebodyLbl = generateName("$whilebody");
      const whileEndLbl = generateName("$whileend");

      // jump to start
      pushStmtsToLastBlock(blocks, ...objstmts, checkObj, { tag: "jmp", lbl: whileStartLbl });
      blocks.push({  a: e.a, label: whileStartLbl, stmts: [] });
      // call hasnext
      const hasnextValName = generateName("condVal");
      const hasnextVal : IR.VarInit<[Type, SourceLocation]> = { name: hasnextValName, type: { tag: "bool" }, value: { tag: "bool", value: false } };
      const hasnextValAssign : IR.Stmt<[Type, SourceLocation]> =  { tag: "assign", name: hasnextValName, value: callHasnext };
      const hasnext : IR.Value<[Type, SourceLocation]> = { a: e.a, tag: "id", name: hasnextValName };
      const hasnextjmp : IR.Stmt<[Type, SourceLocation]> = { tag: "ifjmp", cond: hasnext, thn: whilebodyLbl, els: whileEndLbl };
      pushStmtsToLastBlock(blocks, hasnextValAssign, hasnextjmp);

      // body: call next and print result
      blocks.push({  a: e.a, label: whilebodyLbl, stmts: [] })
      const nextValName = e.item;
      if (e.a[0].tag !== "generator"
        // || e.a[0].tag !== "list"
        // || e.a[0].tag !== "set"
        // || e.a[0].tag !== "dictionary"
      ) {
        throw new Error("Iterable is cursed, go home!");
      }
      const nextVal : IR.VarInit<[Type, SourceLocation]> = { name: nextValName, type: e.a[0].type, value: { tag: "none" } };
      const nextValAssign : IR.Stmt<[Type, SourceLocation]> =  { tag: "assign", name: nextValName, value: callNext };
      const next : IR.Value<[Type, SourceLocation]> = { a: e.a, tag: "id", name: nextValName };
      // evaluate lhs
      const [linits, lstmts, lval] = flattenExprToVal(e.lhs, env);
      const nextYieldName = generateName("nextYield");
      const nextYield : IR.VarInit<[Type, SourceLocation]> = { name: nextYieldName, type: e.a[0].type, value: { tag: "none" } };
      const nextYieldAssign : IR.Stmt<[Type, SourceLocation]> =  { tag: "assign", name: nextYieldName, value: { tag: "value", value: lval } };
      // for this milestone, we just print out the values
      const callPrint : IR.Expr<[Type, SourceLocation]> = { tag: "call", name: "print_num", arguments: [{ a: e.a, tag: "id", name: nextYieldName }] };
      pushStmtsToLastBlock(blocks, checkObj, nextValAssign, ...lstmts, nextYieldAssign, { tag: "expr", expr: callPrint });

      pushStmtsToLastBlock(blocks, { tag: "jmp", lbl: whileStartLbl });

      blocks.push({  a: e.a, label: whileEndLbl, stmts: [] })

      return [
        [...objinits, ...linits, hasnextVal, nextVal, nextYield],
        [],
        { tag: "value", value: lval }
      ]
  }
}

function flattenExprToVal(e : AST.Expr<[Type, SourceLocation]>, env : GlobalEnv) : [Array<IR.VarInit<[Type, SourceLocation]>>, Array<IR.Stmt<[Type, SourceLocation]>>, IR.Value<[Type, SourceLocation]>] {
  var [binits, bstmts, bexpr] = flattenExprToExpr(e, [], env);
  if(bexpr.tag === "value") {
    return [binits, bstmts, bexpr.value];
  }
  else {
    var newName = generateName("valname");
    var setNewName : IR.Stmt<[Type, SourceLocation]> = {
      tag: "assign",
      a: e.a,
      name: newName,
      value: bexpr 
    };
    // TODO: we have to add a new var init for the new variable we're creating here.
    // but what should the default value be?
    return [
      [...binits, { a: e.a, name: newName, type: e.a[0], value: { tag: "none" } }],
      [...bstmts, setNewName],  
      {tag: "id", name: newName, a: e.a}
    ];
  }
}

function pushStmtsToLastBlock(blocks: Array<IR.BasicBlock<[Type, SourceLocation]>>, ...stmts: Array<IR.Stmt<[Type, SourceLocation]>>) {
  blocks[blocks.length - 1].stmts.push(...stmts);
}