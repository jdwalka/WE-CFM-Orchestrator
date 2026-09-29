(module
 (type $0 (func (param i32) (result i32)))
 (type $1 (func (param i32 i32)))
 (type $2 (func (param i32)))
 (type $3 (func (param i32 i32) (result i32)))
 (type $4 (func (param i32 i32 i32)))
 (type $5 (func))
 (type $6 (func (param f64) (result f64)))
 (type $7 (func (param i32 i32 f64)))
 (type $8 (func (param f64 i64) (result i32)))
 (type $9 (func (param i32 i32 i32 i32)))
 (type $10 (func (param i32 i32 i64) (result i32)))
 (type $11 (func (result i32)))
 (type $12 (func (param f64) (result i32)))
 (type $13 (func (param f64 f64) (result f64)))
 (type $14 (func (param f64 f64 f64) (result f64)))
 (type $15 (func (param i32 i32) (result f64)))
 (type $16 (func (param i32) (result f64)))
 (type $17 (func (param i32 i32 i32 i32) (result f64)))
 (type $18 (func (param i32 i32 i32 i32 f64 i32)))
 (import "env" "abort" (func $~lib/builtins/abort (param i32 i32 i32 i32)))
 (global $~lib/native/ASC_SHRINK_LEVEL i32 (i32.const 0))
 (global $~lib/math/rempio2_y0 (mut f64) (f64.const 0))
 (global $~lib/math/rempio2_y1 (mut f64) (f64.const 0))
 (global $~lib/math/res128_hi (mut i64) (i64.const 0))
 (global $~lib/rt/itcms/total (mut i32) (i32.const 0))
 (global $~lib/rt/itcms/threshold (mut i32) (i32.const 0))
 (global $~lib/rt/itcms/state (mut i32) (i32.const 0))
 (global $~lib/rt/itcms/visitCount (mut i32) (i32.const 0))
 (global $~lib/rt/itcms/pinSpace (mut i32) (i32.const 0))
 (global $~lib/rt/itcms/iter (mut i32) (i32.const 0))
 (global $~lib/rt/itcms/toSpace (mut i32) (i32.const 0))
 (global $~lib/rt/itcms/white (mut i32) (i32.const 0))
 (global $~lib/shared/runtime/Runtime.Stub i32 (i32.const 0))
 (global $~lib/shared/runtime/Runtime.Minimal i32 (i32.const 1))
 (global $~lib/shared/runtime/Runtime.Incremental i32 (i32.const 2))
 (global $~lib/rt/itcms/fromSpace (mut i32) (i32.const 0))
 (global $~lib/rt/tlsf/ROOT (mut i32) (i32.const 0))
 (global $~lib/native/ASC_LOW_MEMORY_LIMIT i32 (i32.const 0))
 (global $~lib/native/ASC_RUNTIME i32 (i32.const 2))
 (global $~lib/rt/__rtti_base i32 (i32.const 4816))
 (global $~lib/memory/__data_end i32 (i32.const 4848))
 (global $~lib/memory/__stack_pointer (mut i32) (i32.const 37616))
 (global $~lib/memory/__heap_base i32 (i32.const 37616))
 (memory $0 1)
 (data $0 (i32.const 8) "n\83\f9\a2\00\00\00\00\d1W\'\fc)\15DN\99\95b\db\c0\dd4\f5\abcQ\feA\90C<:n$\b7a\c5\bb\de\ea.I\06\e0\d2MB\1c\eb\1d\fe\1c\92\d1\t\f55\82\e8>\a7)\b1&p\9c\e9\84D\bb.9\d6\919A~_\b4\8b_\84\9c\f49S\83\ff\97\f8\1f;(\f9\bd\8b\11/\ef\0f\98\05\de\cf~6m\1fm\nZf?FO\b7\t\cb\'\c7\ba\'u-\ea_\9e\f79\07={\f1\e5\eb\b1_\fbk\ea\92R\8aF0\03V\08]\8d\1f \bc\cf\f0\abk{\fca\91\e3\a9\1d6\f4\9a_\85\99e\08\1b\e6^\80\d8\ff\8d@h\a0\14W\15\06\061\'sM")
 (data $1 (i32.const 204) "<\00\00\00\00\00\00\00\00\00\00\00\02\00\00\00(\00\00\00A\00l\00l\00o\00c\00a\00t\00i\00o\00n\00 \00t\00o\00o\00 \00l\00a\00r\00g\00e\00\00\00\00\00")
 (data $2 (i32.const 268) "<\00\00\00\00\00\00\00\00\00\00\00\02\00\00\00 \00\00\00~\00l\00i\00b\00/\00r\00t\00/\00i\00t\00c\00m\00s\00.\00t\00s\00\00\00\00\00\00\00\00\00\00\00\00\00")
 (data $3 (i32.const 336) "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00")
 (data $4 (i32.const 368) "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00")
 (data $5 (i32.const 396) "<\00\00\00\00\00\00\00\00\00\00\00\02\00\00\00$\00\00\00I\00n\00d\00e\00x\00 \00o\00u\00t\00 \00o\00f\00 \00r\00a\00n\00g\00e\00\00\00\00\00\00\00\00\00")
 (data $6 (i32.const 460) ",\00\00\00\00\00\00\00\00\00\00\00\02\00\00\00\14\00\00\00~\00l\00i\00b\00/\00r\00t\00.\00t\00s\00\00\00\00\00\00\00\00\00")
 (data $7 (i32.const 512) "\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00")
 (data $8 (i32.const 540) "<\00\00\00\00\00\00\00\00\00\00\00\02\00\00\00\1e\00\00\00~\00l\00i\00b\00/\00r\00t\00/\00t\00l\00s\00f\00.\00t\00s\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00")
 (data $9 (i32.const 604) ",\00\00\00\00\00\00\00\00\00\00\00\02\00\00\00\1c\00\00\00I\00n\00v\00a\00l\00i\00d\00 \00l\00e\00n\00g\00t\00h\00")
 (data $10 (i32.const 652) "<\00\00\00\00\00\00\00\00\00\00\00\02\00\00\00&\00\00\00~\00l\00i\00b\00/\00s\00t\00a\00t\00i\00c\00a\00r\00r\00a\00y\00.\00t\00s\00\00\00\00\00\00\00")
 (data $11 (i32.const 720) "\9f\de\e0\c3\f04\f7?\00\90\e6y\7f\cc\d7\bf\1f\e9,jx\13\f7?\00\00\r\c2\eeo\d7\bf\a0\b5\fa\08`\f2\f6?\00\e0Q\13\e3\13\d7\bf}\8c\13\1f\a6\d1\f6?\00x(8[\b8\d6\bf\d1\b4\c5\0bI\b1\f6?\00x\80\90U]\d6\bf\ba\0c/3G\91\f6?\00\00\18v\d0\02\d6\bf#B\"\18\9fq\f6?\00\90\90\86\ca\a8\d5\bf\d9\1e\a5\99OR\f6?\00P\03VCO\d5\bf\c4$\8f\aaV3\f6?\00@k\c37\f6\d4\bf\14\dc\9dk\b3\14\f6?\00P\a8\fd\a7\9d\d4\bfL\\\c6Rd\f6\f5?\00\a8\899\92E\d4\bfO,\91\b5g\d8\f5?\00\b8\b09\f4\ed\d3\bf\de\90[\cb\bc\ba\f5?\00p\8fD\ce\96\d3\bfx\1a\d9\f2a\9d\f5?\00\a0\bd\17\1e@\d3\bf\87VF\12V\80\f5?\00\80F\ef\e2\e9\d2\bf\d3k\e7\ce\97c\f5?\00\e008\1b\94\d2\bf\93\7f\a7\e2%G\f5?\00\88\da\8c\c5>\d2\bf\83E\06B\ff*\f5?\00\90\')\e1\e9\d1\bf\df\bd\b2\db\"\0f\f5?\00\f8H+m\95\d1\bf\d7\de4G\8f\f3\f4?\00\f8\b9\9agA\d1\bf@(\de\cfC\d8\f4?\00\98\ef\94\d0\ed\d0\bf\c8\a3x\c0>\bd\f4?\00\10\db\18\a5\9a\d0\bf\8a%\e0\c3\7f\a2\f4?\00\b8cR\e6G\d0\bf4\84\d4$\05\88\f4?\00\f0\86E\"\eb\cf\bf\0b-\19\1b\cem\f4?\00\b0\17uJG\cf\bfT\189\d3\d9S\f4?\000\10=D\a4\ce\bfZ\84\b4D\':\f4?\00\b0\e9D\r\02\ce\bf\fb\f8\15A\b5 \f4?\00\f0w)\a2`\cd\bf\b1\f4>\da\82\07\f4?\00\90\95\04\01\c0\cc\bf\8f\feW]\8f\ee\f3?\00\10\89V) \cc\bf\e9L\0b\a0\d9\d5\f3?\00\10\81\8d\17\81\cb\bf+\c1\10\c0`\bd\f3?\00\d0\d3\cc\c9\e2\ca\bf\b8\dau+$\a5\f3?\00\90\12.@E\ca\bf\02\d0\9f\cd\"\8d\f3?\00\f0\1dhw\a8\c9\bf\1cz\84\c5[u\f3?\000Him\0c\c9\bf\e26\adI\ce]\f3?\00\c0E\a6 q\c8\bf@\d4M\98yF\f3?\000\14\b4\8f\d6\c7\bf$\cb\ff\ce\\/\f3?\00pb<\b8<\c7\bfI\r\a1uw\18\f3?\00`7\9b\9a\a3\c6\bf\909>7\c8\01\f3?\00\a0\b7T1\0b\c6\bfA\f8\95\bbN\eb\f2?\000$v}s\c5\bf\d1\a9\19\02\n\d5\f2?\000\c2\8f{\dc\c4\bf*\fd\b7\a8\f9\be\f2?\00\00\d2Q,F\c4\bf\ab\1b\0cz\1c\a9\f2?\00\00\83\bc\8a\b0\c3\bf0\b5\14`r\93\f2?\00\00Ik\99\1b\c3\bf\f5\a1WW\fa}\f2?\00@\a4\90T\87\c2\bf\bf;\1d\9b\b3h\f2?\00\a0y\f8\b9\f3\c1\bf\bd\f5\8f\83\9dS\f2?\00\a0,%\c8`\c1\bf;\08\c9\aa\b7>\f2?\00 \f7W\7f\ce\c0\bf\b6@\a9+\01*\f2?\00\a0\feI\dc<\c0\bf2A\cc\96y\15\f2?\00\80K\bc\bdW\bf\bf\9b\fc\d2\1d \01\f2?\00@@\96\087\be\bf\0bHMI\f4\ec\f1?\00@\f9>\98\17\bd\bfie\8fR\f5\d8\f1?\00\a0\d8Ng\f9\bb\bf|~W\11#\c5\f1?\00`/ y\dc\ba\bf\e9&\cbt|\b1\f1?\00\80(\e7\c3\c0\b9\bf\b6\1a,\0c\01\9e\f1?\00\c0r\b3F\a6\b8\bf\bdp\b6{\b0\8a\f1?\00\00\ac\b3\01\8d\b7\bf\b6\bc\ef%\8aw\f1?\00\008E\f1t\b6\bf\da1L5\8dd\f1?\00\80\87m\0e^\b5\bf\dd_\'\90\b9Q\f1?\00\e0\a1\de\\H\b4\bfL\d22\a4\0e?\f1?\00\a0jM\d93\b3\bf\da\f9\10r\8b,\f1?\00`\c5\f8y \b2\bf1\b5\ec(0\1a\f1?\00 b\98F\0e\b1\bf\af4\84\da\fb\07\f1?\00\00\d2jl\fa\af\bf\b3kN\0f\ee\f5\f0?\00@wJ\8d\da\ad\bf\ce\9f*]\06\e4\f0?\00\00\85\e4\ec\bc\ab\bf!\a5,cD\d2\f0?\00\c0\12@\89\a1\a9\bf\1a\98\e2|\a7\c0\f0?\00\c0\023X\88\a7\bf\d16\c6\83/\af\f0?\00\80\d6g^q\a5\bf9\13\a0\98\db\9d\f0?\00\80eI\8a\\\a3\bf\df\e7R\af\ab\8c\f0?\00@\15d\e3I\a1\bf\fb(N/\9f{\f0?\00\80\eb\82\c0r\9e\bf\19\8f5\8c\b5j\f0?\00\80RR\f1U\9a\bf,\f9\ec\a5\eeY\f0?\00\80\81\cfb=\96\bf\90,\d1\cdII\f0?\00\00\aa\8c\fb(\92\bf\a9\ad\f0\c6\c68\f0?\00\00\f9 {1\8c\bf\a92y\13e(\f0?\00\00\aa]5\19\84\bfHs\ea\'$\18\f0?\00\00\ec\c2\03\12x\bf\95\b1\14\06\04\08\f0?\00\00$y\t\04`\bf\1a\fa&\f7\1f\e0\ef?\00\00\90\84\f3\efo?t\eaa\c2\1c\a1\ef?\00\00=5A\dc\87?.\99\81\b0\10c\ef?\00\80\c2\c4\a3\ce\93?\cd\ad\ee<\f6%\ef?\00\00\89\14\c1\9f\9b?\e7\13\91\03\c8\e9\ee?\00\00\11\ce\d8\b0\a1?\ab\b1\cbx\80\ae\ee?\00\c0\01\d0[\8a\a5?\9b\0c\9d\a2\1at\ee?\00\80\d8@\83\\\a9?\b5\99\n\83\91:\ee?\00\80W\efj\'\ad?V\9a`\t\e0\01\ee?\00\c0\98\e5\98u\b0?\98\bbw\e5\01\ca\ed?\00 \r\e3\f5S\b2?\03\91|\0b\f2\92\ed?\00\008\8b\dd.\b4?\ce\\\fbf\ac\\\ed?\00\c0W\87Y\06\b6?\9d\de^\aa,\'\ed?\00\00j5v\da\b7?\cd,k>n\f2\ec?\00`\1cNC\ab\b9?\02y\a7\a2m\be\ec?\00`\r\bb\c7x\bb?m\087m&\8b\ec?\00 \e72\13C\bd?\04X]\bd\94X\ec?\00`\deq1\n\bf?\8c\9f\bb3\b5&\ec?\00@\91+\15g\c0??\e7\ec\ee\83\f5\eb?\00\b0\92\82\85G\c1?\c1\96\dbu\fd\c4\eb?\000\ca\cdn&\c2?(J\86\0c\1e\95\eb?\00P\c5\a6\d7\03\c3?,>\ef\c5\e2e\eb?\00\103<\c3\df\c3?\8b\88\c9gH7\eb?\00\80zk6\ba\c4?J0\1d!K\t\eb?\00\f0\d1(9\93\c5?~\ef\f2\85\e8\db\ea?\00\f0\18$\cdj\c6?\a2=`1\1d\af\ea?\00\90f\ec\f8@\c7?\a7X\d3?\e6\82\ea?\00\f0\1a\f5\c0\15\c8?\8bs\t\ef@W\ea?\00\80\f6T)\e9\c8?\'K\ab\90*,\ea?\00@\f8\026\bb\c9?\d1\f2\93\13\a0\01\ea?\00\00,\1c\ed\8b\ca?\1b<\db$\9f\d7\e9?\00\d0\01\\Q[\cb?\90\b1\c7\05%\ae\e9?\00\c0\bc\ccg)\cc?/\ce\97\f2.\85\e9?\00`H\d55\f6\cc?uK\a4\ee\ba\\\e9?\00\c0F4\bd\c1\cd?8H\e7\9d\c64\e9?\00\e0\cf\b8\01\8c\ce?\e6Rg/O\r\e9?\00\90\17\c0\tU\cf?\9d\d7\ff\8eR\e6\e8?\00\b8\1f\12l\0e\d0?|\00\cc\9f\ce\bf\e8?\00\d0\93\0e\b8q\d0?\0e\c3\be\da\c0\99\e8?\00p\86\9ek\d4\d0?\fb\17#\aa\'t\e8?\00\d0K3\876\d1?\08\9a\b3\ac\00O\e8?\00H#g\r\98\d1?U>e\e8I*\e8?\00\80\cc\e0\ff\f8\d1?`\02\f4\95\01\06\e8?\00hc\d7_Y\d2?)\a3\e0c%\e2\e7?\00\a8\14\t0\b9\d2?\ad\b5\dcw\b3\be\e7?\00`C\10r\18\d3?\c2%\97g\aa\9b\e7?\00\18\ecm&w\d3?W\06\17\f2\07y\e7?\000\af\fbO\d5\d3?\0c\13\d6\db\caV\e7?\00\e0/\e3\ee2\d4?")
 (data $12 (i32.const 2768) "k\b6O\01\00\10\e6?<[B\91l\02~<\95\b4M\03\000\e6?A]\00H\ea\bf\8d<x\d4\94\r\00P\e6?\b7\a5\d6\86\a7\7f\8e<\adoN\07\00p\e6?L%Tk\ea\fca<\ae\0f\df\fe\ff\8f\e6?\fd\0eYL\'~|\bc\bc\c5c\07\00\b0\e6?\01\da\dcHh\c1\8a\bc\f6\c1\\\1e\00\d0\e6?\11\93I\9d\1c?\83<>\f6\05\eb\ff\ef\e6?S-\e2\1a\04\80~\bc\80\97\86\0e\00\10\e7?Ry\tqf\ff{<\12\e9g\fc\ff/\e7?$\87\bd&\e2\00\8c<j\11\81\df\ffO\e7?\d2\01\f1n\91\02n\bc\90\9cg\0f\00p\e7?t\9cT\cdq\fcg\bc5\c8~\fa\ff\8f\e7?\83\04\f5\9e\c1\be\81<\e6\c2 \fe\ff\af\e7?ed\cc)\17~p\bc\00\c9?\ed\ff\cf\e7?\1c\8b{\08r\80\80\bcv\1a&\e9\ff\ef\e7?\ae\f9\9dm(\c0\8d<\e8\a3\9c\04\00\10\e8?3L\e5Q\d2\7f\89<\8f,\93\17\000\e8?\81\f30\b6\e9\fe\8a\bc\9cs3\06\00P\e8?\bc5ek\bf\bf\89<\c6\89B \00p\e8?u{\11\f3e\bf\8b\bc\04y\f5\eb\ff\8f\e8?W\cb=\a2n\00\89\bc\df\04\bc\"\00\b0\e8?\nK\e08\df\00}\bc\8a\1b\0c\e5\ff\cf\e8?\05\9f\ffFq\00\88\bcC\8e\91\fc\ff\ef\e8?8pz\d0{\81\83<\c7_\fa\1e\00\10\e9?\03\b4\dfv\91>\89<\b9{F\13\000\e9?v\02\98KN\80\7f<o\07\ee\e6\ffO\e9?.b\ff\d9\f0~\8f\bc\d1\12<\de\ffo\e9?\ba8&\96\aa\82p\bc\r\8aE\f4\ff\8f\e9?\ef\a8d\91\1b\80\87\bc>.\98\dd\ff\af\e9?7\93Z\8a\e0@\87\bcf\fbI\ed\ff\cf\e9?\00\e0\9b\c1\08\ce?<Q\9c\f1 \00\f0\e9?\n[\88\'\aa?\8a\bc\06\b0E\11\00\10\ea?V\daX\99H\fft<\fa\f6\bb\07\000\ea?\18m+\8a\ab\be\8c<y\1d\97\10\00P\ea?0yx\dd\ca\fe\88<H.\f5\1d\00p\ea?\db\ab\d8=vA\8f\bcR3Y\1c\00\90\ea?\12v\c2\84\02\bf\8e\bcK>O*\00\b0\ea?_?\ff<\04\fdi\bc\d1\1e\ae\d7\ff\cf\ea?\b4p\90\12\e7>\82\bcx\04Q\ee\ff\ef\ea?\a3\de\0e\e0>\06j<[\re\db\ff\0f\eb?\b9\n\1f8\c8\06Z<W\ca\aa\fe\ff/\eb?\1d<#t\1e\01y\bc\dc\ba\95\d9\ffO\eb?\9f*\86h\10\ffy\bc\9ce\9e$\00p\eb?>O\86\d0E\ff\8a<@\16\87\f9\ff\8f\eb?\f9\c3\c2\96w\fe|<O\cb\04\d2\ff\af\eb?\c4+\f2\ee\'\ffc\bcE\\A\d2\ff\cf\eb?!\ea;\ee\b7\ffl\bc\df\tc\f8\ff\ef\eb?\\\0b.\97\03A\81\bcSv\b5\e1\ff\0f\ec?\19j\b7\94d\c1\8b<\e3W\fa\f1\ff/\ec?\ed\c60\8d\ef\fed\bc$\e4\bf\dc\ffO\ec?uG\ec\bch?\84\bc\f7\b9T\ed\ffo\ec?\ec\e0S\f0\a3~\84<\d5\8f\99\eb\ff\8f\ec?\f1\92\f9\8d\06\83s<\9a!%!\00\b0\ec?\04\0e\18d\8e\fdh\bc\9cF\94\dd\ff\cf\ec?r\ea\c7\1c\be~\8e<v\c4\fd\ea\ff\ef\ec?\fe\88\9f\ad9\be\8e<+\f8\9a\16\00\10\ed?qZ\b9\a8\91}u<\1d\f7\0f\r\000\ed?\da\c7pi\90\c1\89<\c4\0fy\ea\ffO\ed?\0c\feX\c57\0eX\bc\e5\87\dc.\00p\ed?D\0f\c1M\d6\80\7f\bc\aa\82\dc!\00\90\ed?\\\\\fd\94\8f|t\bc\83\02k\d8\ff\af\ed?~a!\c5\1d\7f\8c<9Gl)\00\d0\ed?S\b1\ff\b2\9e\01\88<\f5\90D\e5\ff\ef\ed?\89\ccR\c6\d2\00n<\94\f6\ab\cd\ff\0f\ee?\d2i- @\83\7f\bc\dd\c8R\db\ff/\ee?d\08\1b\ca\c1\00{<\ef\16B\f2\ffO\ee?Q\ab\94\b0\a8\ffr<\11^\8a\e8\ffo\ee?Y\be\ef\b1s\f6W\bc\r\ff\9e\11\00\90\ee?\01\c8\0b^\8d\80\84\bcD\17\a5\df\ff\af\ee?\b5 C\d5\06\00x<\a1\7f\12\1a\00\d0\ee?\92\\V`\f8\02P\bc\c4\bc\ba\07\00\f0\ee?\11\e65]D@\85\bc\02\8dz\f5\ff\0f\ef?\05\91\ef91\fbO\bc\c7\8a\e5\1e\000\ef?U\11s\f2\ac\81\8a<\944\82\f5\ffO\ef?C\c7\d7\d4A?\8a<kL\a9\fc\ffo\ef?ux\98\1c\f4\02b\bcA\c4\f9\e1\ff\8f\ef?K\e7w\f4\d1}w<~\e3\e0\d2\ff\af\ef?1\a3|\9a\19\01o\bc\9e\e4w\1c\00\d0\ef?\b1\ac\ceK\ee\81q<1\c3\e0\f7\ff\ef\ef?Z\87p\017\05n\bcn`e\f4\ff\0f\f0?\da\n\1cI\ad~\8a\bcXz\86\f3\ff/\f0?\e0\b2\fc\c3i\7f\97\bc\17\r\fc\fd\ffO\f0?[\94\cb4\fe\bf\97<\82M\cd\03\00p\f0?\cbV\e4\c0\83\00\82<\e8\cb\f2\f9\ff\8f\f0?\1au7\be\df\ffm\bce\da\0c\01\00\b0\f0?\eb&\e6\ae\7f?\91\bc8\d3\a4\01\00\d0\f0?\f7\9fHy\fa}\80<\fd\fd\da\fa\ff\ef\f0?\c0k\d6p\05\04w\bc\96\fd\ba\0b\00\10\f1?b\0bm\84\d4\80\8e<]\f4\e5\fa\ff/\f1?\ef6\fdd\fa\bf\9d<\d9\9a\d5\r\00P\f1?\aeP\12pw\00\9a<\9aU!\0f\00p\f1?\ee\de\e3\e2\f9\fd\8d<&T\'\fc\ff\8f\f1?sr;\dc0\00\91<Y<=\12\00\b0\f1?\88\01\03\80y\7f\99<\b7\9e)\f8\ff\cf\f1?g\8c\9f\ab2\f9e\bc\00\d4\8a\f4\ff\ef\f1?\eb[\a7\9d\bf\7f\93<\a4\86\8b\0c\00\10\f2?\"[\fd\91k\80\9f<\03C\85\03\000\f2?3\bf\9f\eb\c2\ff\93<\84\f6\bc\ff\ffO\f2?r..~\e7\01v<\d9!)\f5\ffo\f2?a\0c\7fv\bb\fc\7f<<:\93\14\00\90\f2?+A\02<\ca\02r\bc\13cU\14\00\b0\f2?\02\1f\f23\82\80\92\bc;R\fe\eb\ff\cf\f2?\f2\dcO8~\ff\88\bc\96\ad\b8\0b\00\f0\f2?\c5A0PQ\ff\85\bc\af\e2z\fb\ff\0f\f3?\9d(^\88q\00\81\bc\7f_\ac\fe\ff/\f3?\15\b7\b7?]\ff\91\bcVg\a6\0c\00P\f3?\bd\82\8b\"\82\7f\95<!\f7\fb\11\00p\f3?\cc\d5\r\c4\ba\00\80<\b9/Y\f9\ff\8f\f3?Q\a7\b2-\9d?\94\bcB\d2\dd\04\00\b0\f3?\e18vpk\7f\85<W\c9\b2\f5\ff\cf\f3?1\12\bf\10:\02z<\18\b4\b0\ea\ff\ef\f3?\b0R\b1fm\7f\98<\f4\af2\15\00\10\f4?$\85\19_7\f8g<)\8bG\17\000\f4?CQ\dcr\e6\01\83<c\b4\95\e7\ffO\f4?Z\89\b2\b8i\ff\89<\e0u\04\e8\ffo\f4?T\f2\c2\9b\b1\c0\95\bc\e7\c1o\ef\ff\8f\f4?r*:\f2\t@\9b<\04\a7\be\e5\ff\af\f4?E}\r\bf\b7\ff\94\bc\de\'\10\17\00\d0\f4?=j\dcqd\c0\99\bc\e2>\f0\0f\00\f0\f4?\1cS\85\0b\89\7f\97<\d1K\dc\12\00\10\f5?6\a4fqe\04`<z\'\05\16\000\f5?\t2#\ce\ce\bf\96\bcLp\db\ec\ffO\f5?\d7\a1\05\05r\02\89\bc\a9T_\ef\ffo\f5?\12d\c9\0e\e6\bf\9b<\12\10\e6\17\00\90\f5?\90\ef\af\81\c5~\88<\92>\c9\03\00\b0\f5?\c0\0c\bf\n\08A\9f\bc\bc\19I\1d\00\d0\f5?)G%\fb*\81\98\bc\89z\b8\e7\ff\ef\f5?\04i\ed\80\b7~\94\bc")
 (data $13 (i32.const 4816) "\07\00\00\00 \00\00\00 \00\00\00 \00\00\00\00\00\00\00 \00\00\00$\t\00\00$\1a\00\00")
 (table $0 1 1 funcref)
 (elem $0 (i32.const 1))
 (export "contractTensors" (func $assembly/tensor_math/contractTensors))
 (export "runMcts" (func $assembly/tensor_math/runMcts))
 (export "memory" (memory $0))
 (start $~start)
 (func $~lib/math/pio2_large_quot (param $0 f64) (param $1 i64) (result i32)
  (local $2 i64)
  (local $3 i64)
  (local $4 i64)
  (local $5 i32)
  (local $6 i64)
  (local $7 i64)
  (local $8 i64)
  (local $9 i64)
  (local $10 i64)
  (local $11 i64)
  (local $12 i64)
  (local $13 i64)
  (local $14 i64)
  (local $15 i64)
  (local $16 i64)
  (local $17 i64)
  (local $18 i64)
  (local $19 i64)
  (local $20 i64)
  (local $21 i64)
  (local $22 i64)
  (local $23 i64)
  (local $24 i64)
  (local $25 i64)
  (local $26 i64)
  (local $27 i64)
  (local $28 i64)
  (local $29 i64)
  (local $30 i64)
  (local $31 i64)
  (local $32 i64)
  (local $33 i64)
  (local $34 i64)
  (local $35 i64)
  (local $36 i64)
  (local $37 i64)
  (local $38 i64)
  (local $39 i64)
  (local $40 i64)
  (local $41 i64)
  (local $42 i64)
  (local $43 i64)
  (local $44 i64)
  (local $45 i64)
  (local $46 i64)
  (local $47 i64)
  (local $48 i64)
  (local $49 i64)
  (local $50 f64)
  local.get $1
  i64.const 9223372036854775807
  i64.and
  local.set $2
  local.get $2
  i64.const 52
  i64.shr_s
  i64.const 1045
  i64.sub
  local.set $3
  local.get $3
  i64.const 63
  i64.and
  local.set $4
  i32.const 8
  local.get $3
  i64.const 6
  i64.shr_s
  i32.wrap_i64
  i32.const 3
  i32.shl
  i32.add
  local.set $5
  local.get $5
  i64.load
  local.set $9
  local.get $5
  i64.load offset=8
  local.set $10
  local.get $5
  i64.load offset=16
  local.set $11
  local.get $4
  i64.const 0
  i64.ne
  if
   i32.const 64
   i64.extend_i32_s
   local.get $4
   i64.sub
   local.set $12
   local.get $5
   i64.load offset=24
   local.set $13
   local.get $10
   local.get $12
   i64.shr_u
   local.get $9
   local.get $4
   i64.shl
   i64.or
   local.set $6
   local.get $11
   local.get $12
   i64.shr_u
   local.get $10
   local.get $4
   i64.shl
   i64.or
   local.set $7
   local.get $13
   local.get $12
   i64.shr_u
   local.get $11
   local.get $4
   i64.shl
   i64.or
   local.set $8
  else
   local.get $9
   local.set $6
   local.get $10
   local.set $7
   local.get $11
   local.set $8
  end
  local.get $1
  i64.const 4503599627370495
  i64.and
  i64.const 4503599627370496
  i64.or
  local.set $14
  block $~lib/math/umuldi|inlined.0 (result i64)
   local.get $7
   local.set $15
   local.get $14
   local.set $16
   local.get $15
   i64.const 4294967295
   i64.and
   local.set $17
   local.get $16
   i64.const 4294967295
   i64.and
   local.set $18
   local.get $15
   i64.const 32
   i64.shr_u
   local.set $15
   local.get $16
   i64.const 32
   i64.shr_u
   local.set $16
   local.get $17
   local.get $18
   i64.mul
   local.set $21
   local.get $21
   i64.const 4294967295
   i64.and
   local.set $19
   local.get $15
   local.get $18
   i64.mul
   local.get $21
   i64.const 32
   i64.shr_u
   i64.add
   local.set $21
   local.get $21
   i64.const 32
   i64.shr_u
   local.set $20
   local.get $17
   local.get $16
   i64.mul
   local.get $21
   i64.const 4294967295
   i64.and
   i64.add
   local.set $21
   local.get $15
   local.get $16
   i64.mul
   local.get $20
   i64.add
   local.get $21
   i64.const 32
   i64.shr_u
   i64.add
   global.set $~lib/math/res128_hi
   local.get $21
   i64.const 32
   i64.shl
   local.get $19
   i64.add
   br $~lib/math/umuldi|inlined.0
  end
  local.set $22
  global.get $~lib/math/res128_hi
  local.set $23
  local.get $6
  local.get $14
  i64.mul
  local.set $24
  local.get $8
  i64.const 32
  i64.shr_u
  local.get $14
  i64.const 32
  i64.shr_s
  i64.mul
  local.set $25
  local.get $22
  local.get $25
  i64.add
  local.set $26
  local.get $24
  local.get $23
  i64.add
  local.get $26
  local.get $25
  i64.lt_u
  i64.extend_i32_u
  i64.add
  local.set $27
  local.get $26
  i64.const 2
  i64.shl
  local.set $28
  local.get $27
  i64.const 2
  i64.shl
  local.get $26
  i64.const 62
  i64.shr_u
  i64.or
  local.set $29
  local.get $29
  i64.const 63
  i64.shr_s
  local.set $30
  local.get $30
  i64.const 1
  i64.shr_s
  local.set $31
  local.get $27
  i64.const 62
  i64.shr_s
  local.get $30
  i64.sub
  local.set $32
  i64.const 4372995238176751616
  block $~lib/math/pio2_right|inlined.0 (result i64)
   local.get $28
   local.get $30
   i64.xor
   local.set $33
   local.get $29
   local.get $31
   i64.xor
   local.set $34
   local.get $34
   i64.clz
   local.set $35
   local.get $34
   local.get $35
   i64.shl
   local.get $33
   i64.const 64
   local.get $35
   i64.sub
   i64.shr_u
   i64.or
   local.set $34
   local.get $33
   local.get $35
   i64.shl
   local.set $33
   block $~lib/math/umuldi|inlined.1 (result i64)
    i64.const -3958705157555305932
    local.set $36
    local.get $34
    local.set $37
    local.get $36
    i64.const 4294967295
    i64.and
    local.set $38
    local.get $37
    i64.const 4294967295
    i64.and
    local.set $39
    local.get $36
    i64.const 32
    i64.shr_u
    local.set $36
    local.get $37
    i64.const 32
    i64.shr_u
    local.set $37
    local.get $38
    local.get $39
    i64.mul
    local.set $42
    local.get $42
    i64.const 4294967295
    i64.and
    local.set $40
    local.get $36
    local.get $39
    i64.mul
    local.get $42
    i64.const 32
    i64.shr_u
    i64.add
    local.set $42
    local.get $42
    i64.const 32
    i64.shr_u
    local.set $41
    local.get $38
    local.get $37
    i64.mul
    local.get $42
    i64.const 4294967295
    i64.and
    i64.add
    local.set $42
    local.get $36
    local.get $37
    i64.mul
    local.get $41
    i64.add
    local.get $42
    i64.const 32
    i64.shr_u
    i64.add
    global.set $~lib/math/res128_hi
    local.get $42
    i64.const 32
    i64.shl
    local.get $40
    i64.add
    br $~lib/math/umuldi|inlined.1
   end
   local.set $43
   global.get $~lib/math/res128_hi
   local.set $44
   local.get $44
   i64.const 11
   i64.shr_u
   local.set $45
   local.get $43
   i64.const 11
   i64.shr_u
   local.get $44
   i64.const 53
   i64.shl
   i64.or
   local.set $46
   f64.const 2.6469779601696886e-23
   i64.const -4267615245585081135
   f64.convert_i64_u
   f64.mul
   local.get $34
   f64.convert_i64_u
   f64.mul
   f64.const 2.6469779601696886e-23
   i64.const -3958705157555305932
   f64.convert_i64_u
   f64.mul
   local.get $33
   f64.convert_i64_u
   f64.mul
   f64.add
   i64.trunc_sat_f64_u
   local.set $47
   local.get $45
   local.get $43
   local.get $47
   i64.lt_u
   i64.extend_i32_u
   i64.add
   f64.convert_i64_u
   global.set $~lib/math/rempio2_y0
   f64.const 5.421010862427522e-20
   local.get $46
   local.get $47
   i64.add
   f64.convert_i64_u
   f64.mul
   global.set $~lib/math/rempio2_y1
   local.get $35
   br $~lib/math/pio2_right|inlined.0
  end
  i64.const 52
  i64.shl
  i64.sub
  local.set $48
  local.get $1
  local.get $29
  i64.xor
  i64.const -9223372036854775808
  i64.and
  local.set $49
  local.get $48
  local.get $49
  i64.or
  f64.reinterpret_i64
  local.set $50
  global.get $~lib/math/rempio2_y0
  local.get $50
  f64.mul
  global.set $~lib/math/rempio2_y0
  global.get $~lib/math/rempio2_y1
  local.get $50
  f64.mul
  global.set $~lib/math/rempio2_y1
  local.get $32
  i32.wrap_i64
  return
 )
 (func $~lib/math/NativeMath.cos (param $0 f64) (result f64)
  (local $1 i64)
  (local $2 i32)
  (local $3 i32)
  (local $4 f64)
  (local $5 f64)
  (local $6 f64)
  (local $7 f64)
  (local $8 f64)
  (local $9 f64)
  (local $10 f64)
  (local $11 i64)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 f64)
  (local $16 f64)
  (local $17 f64)
  (local $18 f64)
  (local $19 f64)
  (local $20 f64)
  (local $21 i32)
  (local $22 f64)
  (local $23 i32)
  (local $24 i32)
  (local $25 f64)
  (local $26 f64)
  (local $27 f64)
  (local $28 i32)
  (local $29 i32)
  (local $30 f64)
  (local $31 f64)
  (local $32 f64)
  (local $33 f64)
  (local $34 i32)
  (local $35 f64)
  (local $36 f64)
  (local $37 f64)
  (local $38 f64)
  (local $39 f64)
  (local $40 f64)
  (local $41 f64)
  (local $42 f64)
  (local $43 f64)
  (local $44 f64)
  local.get $0
  i64.reinterpret_f64
  local.set $1
  local.get $1
  i64.const 32
  i64.shr_u
  i32.wrap_i64
  local.set $2
  local.get $2
  i32.const 31
  i32.shr_u
  local.set $3
  local.get $2
  i32.const 2147483647
  i32.and
  local.set $2
  local.get $2
  i32.const 1072243195
  i32.le_u
  if
   local.get $2
   i32.const 1044816030
   i32.lt_u
   if
    f64.const 1
    return
   end
   block $~lib/math/cos_kern|inlined.0 (result f64)
    local.get $0
    local.set $4
    f64.const 0
    local.set $5
    local.get $4
    local.get $4
    f64.mul
    local.set $6
    local.get $6
    local.get $6
    f64.mul
    local.set $7
    local.get $6
    f64.const 0.0416666666666666
    local.get $6
    f64.const -0.001388888888887411
    local.get $6
    f64.const 2.480158728947673e-05
    f64.mul
    f64.add
    f64.mul
    f64.add
    f64.mul
    local.get $7
    local.get $7
    f64.mul
    f64.const -2.7557314351390663e-07
    local.get $6
    f64.const 2.087572321298175e-09
    local.get $6
    f64.const -1.1359647557788195e-11
    f64.mul
    f64.add
    f64.mul
    f64.add
    f64.mul
    f64.add
    local.set $8
    f64.const 0.5
    local.get $6
    f64.mul
    local.set $9
    f64.const 1
    local.get $9
    f64.sub
    local.set $7
    local.get $7
    f64.const 1
    local.get $7
    f64.sub
    local.get $9
    f64.sub
    local.get $6
    local.get $8
    f64.mul
    local.get $4
    local.get $5
    f64.mul
    f64.sub
    f64.add
    f64.add
    br $~lib/math/cos_kern|inlined.0
   end
   return
  end
  local.get $2
  i32.const 2146435072
  i32.ge_u
  if
   local.get $0
   local.get $0
   f64.sub
   return
  end
  block $~lib/math/rempio2|inlined.0 (result i32)
   local.get $0
   local.set $10
   local.get $1
   local.set $11
   local.get $3
   local.set $12
   local.get $11
   i64.const 32
   i64.shr_u
   i32.wrap_i64
   i32.const 2147483647
   i32.and
   local.set $13
   i32.const 0
   i32.const 1
   i32.lt_s
   drop
   local.get $13
   i32.const 1073928572
   i32.lt_u
   if
    i32.const 1
    local.set $14
    local.get $12
    i32.eqz
    if
     local.get $10
     f64.const 1.5707963267341256
     f64.sub
     local.set $15
     local.get $13
     i32.const 1073291771
     i32.ne
     if
      local.get $15
      f64.const 6.077100506506192e-11
      f64.sub
      local.set $16
      local.get $15
      local.get $16
      f64.sub
      f64.const 6.077100506506192e-11
      f64.sub
      local.set $17
     else
      local.get $15
      f64.const 6.077100506303966e-11
      f64.sub
      local.set $15
      local.get $15
      f64.const 2.0222662487959506e-21
      f64.sub
      local.set $16
      local.get $15
      local.get $16
      f64.sub
      f64.const 2.0222662487959506e-21
      f64.sub
      local.set $17
     end
    else
     local.get $10
     f64.const 1.5707963267341256
     f64.add
     local.set $15
     local.get $13
     i32.const 1073291771
     i32.ne
     if
      local.get $15
      f64.const 6.077100506506192e-11
      f64.add
      local.set $16
      local.get $15
      local.get $16
      f64.sub
      f64.const 6.077100506506192e-11
      f64.add
      local.set $17
     else
      local.get $15
      f64.const 6.077100506303966e-11
      f64.add
      local.set $15
      local.get $15
      f64.const 2.0222662487959506e-21
      f64.add
      local.set $16
      local.get $15
      local.get $16
      f64.sub
      f64.const 2.0222662487959506e-21
      f64.add
      local.set $17
     end
     i32.const -1
     local.set $14
    end
    local.get $16
    global.set $~lib/math/rempio2_y0
    local.get $17
    global.set $~lib/math/rempio2_y1
    local.get $14
    br $~lib/math/rempio2|inlined.0
   end
   local.get $13
   i32.const 1094263291
   i32.lt_u
   if
    local.get $10
    f64.const 0.6366197723675814
    f64.mul
    f64.nearest
    local.set $18
    local.get $10
    local.get $18
    f64.const 1.5707963267341256
    f64.mul
    f64.sub
    local.set $19
    local.get $18
    f64.const 6.077100506506192e-11
    f64.mul
    local.set $20
    local.get $13
    i32.const 20
    i32.shr_u
    local.set $21
    local.get $19
    local.get $20
    f64.sub
    local.set $22
    local.get $22
    i64.reinterpret_f64
    i64.const 32
    i64.shr_u
    i32.wrap_i64
    local.set $23
    local.get $21
    local.get $23
    i32.const 20
    i32.shr_u
    i32.const 2047
    i32.and
    i32.sub
    local.set $24
    local.get $24
    i32.const 16
    i32.gt_u
    if
     local.get $19
     local.set $25
     local.get $18
     f64.const 6.077100506303966e-11
     f64.mul
     local.set $20
     local.get $25
     local.get $20
     f64.sub
     local.set $19
     local.get $18
     f64.const 2.0222662487959506e-21
     f64.mul
     local.get $25
     local.get $19
     f64.sub
     local.get $20
     f64.sub
     f64.sub
     local.set $20
     local.get $19
     local.get $20
     f64.sub
     local.set $22
     local.get $22
     i64.reinterpret_f64
     i64.const 32
     i64.shr_u
     i32.wrap_i64
     local.set $23
     local.get $21
     local.get $23
     i32.const 20
     i32.shr_u
     i32.const 2047
     i32.and
     i32.sub
     local.set $24
     local.get $24
     i32.const 49
     i32.gt_u
     if
      local.get $19
      local.set $26
      local.get $18
      f64.const 2.0222662487111665e-21
      f64.mul
      local.set $20
      local.get $26
      local.get $20
      f64.sub
      local.set $19
      local.get $18
      f64.const 8.4784276603689e-32
      f64.mul
      local.get $26
      local.get $19
      f64.sub
      local.get $20
      f64.sub
      f64.sub
      local.set $20
      local.get $19
      local.get $20
      f64.sub
      local.set $22
     end
    end
    local.get $19
    local.get $22
    f64.sub
    local.get $20
    f64.sub
    local.set $27
    local.get $22
    global.set $~lib/math/rempio2_y0
    local.get $27
    global.set $~lib/math/rempio2_y1
    local.get $18
    i32.trunc_sat_f64_s
    br $~lib/math/rempio2|inlined.0
   end
   local.get $10
   local.get $11
   call $~lib/math/pio2_large_quot
   local.set $28
   i32.const 0
   local.get $28
   i32.sub
   local.get $28
   local.get $12
   select
   br $~lib/math/rempio2|inlined.0
  end
  local.set $29
  global.get $~lib/math/rempio2_y0
  local.set $30
  global.get $~lib/math/rempio2_y1
  local.set $31
  local.get $29
  i32.const 1
  i32.and
  if (result f64)
   block $~lib/math/sin_kern|inlined.0 (result f64)
    local.get $30
    local.set $32
    local.get $31
    local.set $33
    i32.const 1
    local.set $34
    local.get $32
    local.get $32
    f64.mul
    local.set $35
    local.get $35
    local.get $35
    f64.mul
    local.set $36
    f64.const 0.00833333333332249
    local.get $35
    f64.const -1.984126982985795e-04
    local.get $35
    f64.const 2.7557313707070068e-06
    f64.mul
    f64.add
    f64.mul
    f64.add
    local.get $35
    local.get $36
    f64.mul
    f64.const -2.5050760253406863e-08
    local.get $35
    f64.const 1.58969099521155e-10
    f64.mul
    f64.add
    f64.mul
    f64.add
    local.set $37
    local.get $35
    local.get $32
    f64.mul
    local.set $38
    local.get $34
    i32.eqz
    if
     local.get $32
     local.get $38
     f64.const -0.16666666666666632
     local.get $35
     local.get $37
     f64.mul
     f64.add
     f64.mul
     f64.add
     br $~lib/math/sin_kern|inlined.0
    else
     local.get $32
     local.get $35
     f64.const 0.5
     local.get $33
     f64.mul
     local.get $38
     local.get $37
     f64.mul
     f64.sub
     f64.mul
     local.get $33
     f64.sub
     local.get $38
     f64.const -0.16666666666666632
     f64.mul
     f64.sub
     f64.sub
     br $~lib/math/sin_kern|inlined.0
    end
    unreachable
   end
  else
   block $~lib/math/cos_kern|inlined.1 (result f64)
    local.get $30
    local.set $39
    local.get $31
    local.set $40
    local.get $39
    local.get $39
    f64.mul
    local.set $41
    local.get $41
    local.get $41
    f64.mul
    local.set $42
    local.get $41
    f64.const 0.0416666666666666
    local.get $41
    f64.const -0.001388888888887411
    local.get $41
    f64.const 2.480158728947673e-05
    f64.mul
    f64.add
    f64.mul
    f64.add
    f64.mul
    local.get $42
    local.get $42
    f64.mul
    f64.const -2.7557314351390663e-07
    local.get $41
    f64.const 2.087572321298175e-09
    local.get $41
    f64.const -1.1359647557788195e-11
    f64.mul
    f64.add
    f64.mul
    f64.add
    f64.mul
    f64.add
    local.set $43
    f64.const 0.5
    local.get $41
    f64.mul
    local.set $44
    f64.const 1
    local.get $44
    f64.sub
    local.set $42
    local.get $42
    f64.const 1
    local.get $42
    f64.sub
    local.get $44
    f64.sub
    local.get $41
    local.get $43
    f64.mul
    local.get $39
    local.get $40
    f64.mul
    f64.sub
    f64.add
    f64.add
    br $~lib/math/cos_kern|inlined.1
   end
  end
  local.set $0
  local.get $29
  i32.const 1
  i32.add
  i32.const 2
  i32.and
  if (result f64)
   local.get $0
   f64.neg
  else
   local.get $0
  end
  return
 )
 (func $~lib/math/NativeMath.sin (param $0 f64) (result f64)
  (local $1 i64)
  (local $2 i32)
  (local $3 i32)
  (local $4 f64)
  (local $5 f64)
  (local $6 i32)
  (local $7 f64)
  (local $8 f64)
  (local $9 f64)
  (local $10 f64)
  (local $11 f64)
  (local $12 i64)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 f64)
  (local $17 f64)
  (local $18 f64)
  (local $19 f64)
  (local $20 f64)
  (local $21 f64)
  (local $22 i32)
  (local $23 f64)
  (local $24 i32)
  (local $25 i32)
  (local $26 f64)
  (local $27 f64)
  (local $28 f64)
  (local $29 i32)
  (local $30 i32)
  (local $31 f64)
  (local $32 f64)
  (local $33 f64)
  (local $34 f64)
  (local $35 f64)
  (local $36 f64)
  (local $37 f64)
  (local $38 f64)
  (local $39 f64)
  (local $40 f64)
  (local $41 i32)
  (local $42 f64)
  (local $43 f64)
  (local $44 f64)
  (local $45 f64)
  local.get $0
  i64.reinterpret_f64
  local.set $1
  local.get $1
  i64.const 32
  i64.shr_u
  i32.wrap_i64
  local.set $2
  local.get $2
  i32.const 31
  i32.shr_u
  local.set $3
  local.get $2
  i32.const 2147483647
  i32.and
  local.set $2
  local.get $2
  i32.const 1072243195
  i32.le_u
  if
   local.get $2
   i32.const 1045430272
   i32.lt_u
   if
    local.get $0
    return
   end
   block $~lib/math/sin_kern|inlined.1 (result f64)
    local.get $0
    local.set $4
    f64.const 0
    local.set $5
    i32.const 0
    local.set $6
    local.get $4
    local.get $4
    f64.mul
    local.set $7
    local.get $7
    local.get $7
    f64.mul
    local.set $8
    f64.const 0.00833333333332249
    local.get $7
    f64.const -1.984126982985795e-04
    local.get $7
    f64.const 2.7557313707070068e-06
    f64.mul
    f64.add
    f64.mul
    f64.add
    local.get $7
    local.get $8
    f64.mul
    f64.const -2.5050760253406863e-08
    local.get $7
    f64.const 1.58969099521155e-10
    f64.mul
    f64.add
    f64.mul
    f64.add
    local.set $9
    local.get $7
    local.get $4
    f64.mul
    local.set $10
    local.get $6
    i32.eqz
    if
     local.get $4
     local.get $10
     f64.const -0.16666666666666632
     local.get $7
     local.get $9
     f64.mul
     f64.add
     f64.mul
     f64.add
     br $~lib/math/sin_kern|inlined.1
    else
     local.get $4
     local.get $7
     f64.const 0.5
     local.get $5
     f64.mul
     local.get $10
     local.get $9
     f64.mul
     f64.sub
     f64.mul
     local.get $5
     f64.sub
     local.get $10
     f64.const -0.16666666666666632
     f64.mul
     f64.sub
     f64.sub
     br $~lib/math/sin_kern|inlined.1
    end
    unreachable
   end
   return
  end
  local.get $2
  i32.const 2146435072
  i32.ge_u
  if
   local.get $0
   local.get $0
   f64.sub
   return
  end
  block $~lib/math/rempio2|inlined.1 (result i32)
   local.get $0
   local.set $11
   local.get $1
   local.set $12
   local.get $3
   local.set $13
   local.get $12
   i64.const 32
   i64.shr_u
   i32.wrap_i64
   i32.const 2147483647
   i32.and
   local.set $14
   i32.const 0
   i32.const 1
   i32.lt_s
   drop
   local.get $14
   i32.const 1073928572
   i32.lt_u
   if
    i32.const 1
    local.set $15
    local.get $13
    i32.eqz
    if
     local.get $11
     f64.const 1.5707963267341256
     f64.sub
     local.set $16
     local.get $14
     i32.const 1073291771
     i32.ne
     if
      local.get $16
      f64.const 6.077100506506192e-11
      f64.sub
      local.set $17
      local.get $16
      local.get $17
      f64.sub
      f64.const 6.077100506506192e-11
      f64.sub
      local.set $18
     else
      local.get $16
      f64.const 6.077100506303966e-11
      f64.sub
      local.set $16
      local.get $16
      f64.const 2.0222662487959506e-21
      f64.sub
      local.set $17
      local.get $16
      local.get $17
      f64.sub
      f64.const 2.0222662487959506e-21
      f64.sub
      local.set $18
     end
    else
     local.get $11
     f64.const 1.5707963267341256
     f64.add
     local.set $16
     local.get $14
     i32.const 1073291771
     i32.ne
     if
      local.get $16
      f64.const 6.077100506506192e-11
      f64.add
      local.set $17
      local.get $16
      local.get $17
      f64.sub
      f64.const 6.077100506506192e-11
      f64.add
      local.set $18
     else
      local.get $16
      f64.const 6.077100506303966e-11
      f64.add
      local.set $16
      local.get $16
      f64.const 2.0222662487959506e-21
      f64.add
      local.set $17
      local.get $16
      local.get $17
      f64.sub
      f64.const 2.0222662487959506e-21
      f64.add
      local.set $18
     end
     i32.const -1
     local.set $15
    end
    local.get $17
    global.set $~lib/math/rempio2_y0
    local.get $18
    global.set $~lib/math/rempio2_y1
    local.get $15
    br $~lib/math/rempio2|inlined.1
   end
   local.get $14
   i32.const 1094263291
   i32.lt_u
   if
    local.get $11
    f64.const 0.6366197723675814
    f64.mul
    f64.nearest
    local.set $19
    local.get $11
    local.get $19
    f64.const 1.5707963267341256
    f64.mul
    f64.sub
    local.set $20
    local.get $19
    f64.const 6.077100506506192e-11
    f64.mul
    local.set $21
    local.get $14
    i32.const 20
    i32.shr_u
    local.set $22
    local.get $20
    local.get $21
    f64.sub
    local.set $23
    local.get $23
    i64.reinterpret_f64
    i64.const 32
    i64.shr_u
    i32.wrap_i64
    local.set $24
    local.get $22
    local.get $24
    i32.const 20
    i32.shr_u
    i32.const 2047
    i32.and
    i32.sub
    local.set $25
    local.get $25
    i32.const 16
    i32.gt_u
    if
     local.get $20
     local.set $26
     local.get $19
     f64.const 6.077100506303966e-11
     f64.mul
     local.set $21
     local.get $26
     local.get $21
     f64.sub
     local.set $20
     local.get $19
     f64.const 2.0222662487959506e-21
     f64.mul
     local.get $26
     local.get $20
     f64.sub
     local.get $21
     f64.sub
     f64.sub
     local.set $21
     local.get $20
     local.get $21
     f64.sub
     local.set $23
     local.get $23
     i64.reinterpret_f64
     i64.const 32
     i64.shr_u
     i32.wrap_i64
     local.set $24
     local.get $22
     local.get $24
     i32.const 20
     i32.shr_u
     i32.const 2047
     i32.and
     i32.sub
     local.set $25
     local.get $25
     i32.const 49
     i32.gt_u
     if
      local.get $20
      local.set $27
      local.get $19
      f64.const 2.0222662487111665e-21
      f64.mul
      local.set $21
      local.get $27
      local.get $21
      f64.sub
      local.set $20
      local.get $19
      f64.const 8.4784276603689e-32
      f64.mul
      local.get $27
      local.get $20
      f64.sub
      local.get $21
      f64.sub
      f64.sub
      local.set $21
      local.get $20
      local.get $21
      f64.sub
      local.set $23
     end
    end
    local.get $20
    local.get $23
    f64.sub
    local.get $21
    f64.sub
    local.set $28
    local.get $23
    global.set $~lib/math/rempio2_y0
    local.get $28
    global.set $~lib/math/rempio2_y1
    local.get $19
    i32.trunc_sat_f64_s
    br $~lib/math/rempio2|inlined.1
   end
   local.get $11
   local.get $12
   call $~lib/math/pio2_large_quot
   local.set $29
   i32.const 0
   local.get $29
   i32.sub
   local.get $29
   local.get $13
   select
   br $~lib/math/rempio2|inlined.1
  end
  local.set $30
  global.get $~lib/math/rempio2_y0
  local.set $31
  global.get $~lib/math/rempio2_y1
  local.set $32
  local.get $30
  i32.const 1
  i32.and
  if (result f64)
   block $~lib/math/cos_kern|inlined.2 (result f64)
    local.get $31
    local.set $33
    local.get $32
    local.set $34
    local.get $33
    local.get $33
    f64.mul
    local.set $35
    local.get $35
    local.get $35
    f64.mul
    local.set $36
    local.get $35
    f64.const 0.0416666666666666
    local.get $35
    f64.const -0.001388888888887411
    local.get $35
    f64.const 2.480158728947673e-05
    f64.mul
    f64.add
    f64.mul
    f64.add
    f64.mul
    local.get $36
    local.get $36
    f64.mul
    f64.const -2.7557314351390663e-07
    local.get $35
    f64.const 2.087572321298175e-09
    local.get $35
    f64.const -1.1359647557788195e-11
    f64.mul
    f64.add
    f64.mul
    f64.add
    f64.mul
    f64.add
    local.set $37
    f64.const 0.5
    local.get $35
    f64.mul
    local.set $38
    f64.const 1
    local.get $38
    f64.sub
    local.set $36
    local.get $36
    f64.const 1
    local.get $36
    f64.sub
    local.get $38
    f64.sub
    local.get $35
    local.get $37
    f64.mul
    local.get $33
    local.get $34
    f64.mul
    f64.sub
    f64.add
    f64.add
    br $~lib/math/cos_kern|inlined.2
   end
  else
   block $~lib/math/sin_kern|inlined.2 (result f64)
    local.get $31
    local.set $39
    local.get $32
    local.set $40
    i32.const 1
    local.set $41
    local.get $39
    local.get $39
    f64.mul
    local.set $42
    local.get $42
    local.get $42
    f64.mul
    local.set $43
    f64.const 0.00833333333332249
    local.get $42
    f64.const -1.984126982985795e-04
    local.get $42
    f64.const 2.7557313707070068e-06
    f64.mul
    f64.add
    f64.mul
    f64.add
    local.get $42
    local.get $43
    f64.mul
    f64.const -2.5050760253406863e-08
    local.get $42
    f64.const 1.58969099521155e-10
    f64.mul
    f64.add
    f64.mul
    f64.add
    local.set $44
    local.get $42
    local.get $39
    f64.mul
    local.set $45
    local.get $41
    i32.eqz
    if
     local.get $39
     local.get $45
     f64.const -0.16666666666666632
     local.get $42
     local.get $44
     f64.mul
     f64.add
     f64.mul
     f64.add
     br $~lib/math/sin_kern|inlined.2
    else
     local.get $39
     local.get $42
     f64.const 0.5
     local.get $40
     f64.mul
     local.get $45
     local.get $44
     f64.mul
     f64.sub
     f64.mul
     local.get $40
     f64.sub
     local.get $45
     f64.const -0.16666666666666632
     f64.mul
     f64.sub
     f64.sub
     br $~lib/math/sin_kern|inlined.2
    end
    unreachable
   end
  end
  local.set $0
  local.get $30
  i32.const 2
  i32.and
  if (result f64)
   local.get $0
   f64.neg
  else
   local.get $0
  end
  return
 )
 (func $assembly/tensor_math/contractTensors (param $0 i32) (param $1 i32) (param $2 f64)
  (local $3 f64)
  (local $4 f64)
  (local $5 i32)
  (local $6 i32)
  (local $7 v128)
  (local $8 f64)
  (local $9 f64)
  (local $10 f64)
  (local $11 f64)
  (local $12 v128)
  local.get $2
  call $~lib/math/NativeMath.cos
  local.set $3
  local.get $2
  call $~lib/math/NativeMath.sin
  local.set $4
  local.get $0
  local.get $1
  i32.const 3
  i32.shl
  i32.add
  local.set $5
  local.get $0
  local.set $6
  loop $for-loop|0
   local.get $6
   local.get $5
   i32.lt_u
   if
    local.get $6
    v128.load
    local.set $7
    local.get $7
    f64x2.extract_lane 0
    local.set $8
    local.get $7
    f64x2.extract_lane 1
    local.set $9
    local.get $8
    local.get $3
    f64.mul
    local.get $9
    local.get $4
    f64.mul
    f64.sub
    local.set $10
    local.get $8
    local.get $4
    f64.mul
    local.get $9
    local.get $3
    f64.mul
    f64.add
    local.set $11
    f64.const 0
    f64x2.splat
    local.get $10
    f64x2.replace_lane 0
    local.get $11
    f64x2.replace_lane 1
    local.set $12
    local.get $6
    local.get $12
    v128.store
    local.get $6
    i32.const 16
    i32.add
    local.set $6
    br $for-loop|0
   end
  end
 )
 (func $assembly/tensor_math/RNG#set:s (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store
 )
 (func $~lib/rt/itcms/Object#set:nextWithColor (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store offset=4
 )
 (func $~lib/rt/itcms/Object#set:prev (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store offset=8
 )
 (func $~lib/rt/itcms/initLazy (param $0 i32) (result i32)
  local.get $0
  local.get $0
  call $~lib/rt/itcms/Object#set:nextWithColor
  local.get $0
  local.get $0
  call $~lib/rt/itcms/Object#set:prev
  local.get $0
  return
 )
 (func $~lib/rt/itcms/Object#get:nextWithColor (param $0 i32) (result i32)
  local.get $0
  i32.load offset=4
 )
 (func $~lib/rt/itcms/Object#get:next (param $0 i32) (result i32)
  local.get $0
  call $~lib/rt/itcms/Object#get:nextWithColor
  i32.const 3
  i32.const -1
  i32.xor
  i32.and
  return
 )
 (func $~lib/rt/itcms/Object#get:color (param $0 i32) (result i32)
  local.get $0
  call $~lib/rt/itcms/Object#get:nextWithColor
  i32.const 3
  i32.and
  return
 )
 (func $~lib/rt/itcms/visitRoots (param $0 i32)
  (local $1 i32)
  (local $2 i32)
  local.get $0
  call $~lib/rt/__visit_globals
  global.get $~lib/rt/itcms/pinSpace
  local.set $1
  local.get $1
  call $~lib/rt/itcms/Object#get:next
  local.set $2
  loop $while-continue|0
   local.get $2
   local.get $1
   i32.ne
   if
    i32.const 1
    drop
    local.get $2
    call $~lib/rt/itcms/Object#get:color
    i32.const 3
    i32.eq
    i32.eqz
    if
     i32.const 0
     i32.const 288
     i32.const 160
     i32.const 16
     call $~lib/builtins/abort
     unreachable
    end
    local.get $2
    i32.const 20
    i32.add
    local.get $0
    call $~lib/rt/__visit_members
    local.get $2
    call $~lib/rt/itcms/Object#get:next
    local.set $2
    br $while-continue|0
   end
  end
 )
 (func $~lib/rt/itcms/Object#set:color (param $0 i32) (param $1 i32)
  local.get $0
  local.get $0
  call $~lib/rt/itcms/Object#get:nextWithColor
  i32.const 3
  i32.const -1
  i32.xor
  i32.and
  local.get $1
  i32.or
  call $~lib/rt/itcms/Object#set:nextWithColor
 )
 (func $~lib/rt/itcms/Object#get:prev (param $0 i32) (result i32)
  local.get $0
  i32.load offset=8
 )
 (func $~lib/rt/itcms/Object#set:next (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  local.get $0
  call $~lib/rt/itcms/Object#get:nextWithColor
  i32.const 3
  i32.and
  i32.or
  call $~lib/rt/itcms/Object#set:nextWithColor
 )
 (func $~lib/rt/itcms/Object#unlink (param $0 i32)
  (local $1 i32)
  (local $2 i32)
  local.get $0
  call $~lib/rt/itcms/Object#get:next
  local.set $1
  local.get $1
  i32.const 0
  i32.eq
  if
   i32.const 1
   drop
   local.get $0
   call $~lib/rt/itcms/Object#get:prev
   i32.const 0
   i32.eq
   if (result i32)
    local.get $0
    global.get $~lib/memory/__heap_base
    i32.lt_u
   else
    i32.const 0
   end
   i32.eqz
   if
    i32.const 0
    i32.const 288
    i32.const 128
    i32.const 18
    call $~lib/builtins/abort
    unreachable
   end
   return
  end
  local.get $0
  call $~lib/rt/itcms/Object#get:prev
  local.set $2
  i32.const 1
  drop
  local.get $2
  i32.eqz
  if
   i32.const 0
   i32.const 288
   i32.const 132
   i32.const 16
   call $~lib/builtins/abort
   unreachable
  end
  local.get $1
  local.get $2
  call $~lib/rt/itcms/Object#set:prev
  local.get $2
  local.get $1
  call $~lib/rt/itcms/Object#set:next
 )
 (func $~lib/rt/itcms/Object#get:rtId (param $0 i32) (result i32)
  local.get $0
  i32.load offset=12
 )
 (func $~lib/shared/typeinfo/Typeinfo#get:flags (param $0 i32) (result i32)
  local.get $0
  i32.load
 )
 (func $~lib/rt/__typeinfo (param $0 i32) (result i32)
  (local $1 i32)
  global.get $~lib/rt/__rtti_base
  local.set $1
  local.get $0
  local.get $1
  i32.load
  i32.gt_u
  if
   i32.const 416
   i32.const 480
   i32.const 21
   i32.const 28
   call $~lib/builtins/abort
   unreachable
  end
  local.get $1
  i32.const 4
  i32.add
  local.get $0
  i32.const 4
  i32.mul
  i32.add
  call $~lib/shared/typeinfo/Typeinfo#get:flags
  return
 )
 (func $~lib/rt/itcms/Object#get:isPointerfree (param $0 i32) (result i32)
  (local $1 i32)
  local.get $0
  call $~lib/rt/itcms/Object#get:rtId
  local.set $1
  local.get $1
  i32.const 2
  i32.le_u
  if (result i32)
   i32.const 1
  else
   local.get $1
   call $~lib/rt/__typeinfo
   i32.const 32
   i32.and
   i32.const 0
   i32.ne
  end
  return
 )
 (func $~lib/rt/itcms/Object#linkTo (param $0 i32) (param $1 i32) (param $2 i32)
  (local $3 i32)
  local.get $1
  call $~lib/rt/itcms/Object#get:prev
  local.set $3
  local.get $0
  local.get $1
  local.get $2
  i32.or
  call $~lib/rt/itcms/Object#set:nextWithColor
  local.get $0
  local.get $3
  call $~lib/rt/itcms/Object#set:prev
  local.get $3
  local.get $0
  call $~lib/rt/itcms/Object#set:next
  local.get $1
  local.get $0
  call $~lib/rt/itcms/Object#set:prev
 )
 (func $~lib/rt/itcms/Object#makeGray (param $0 i32)
  (local $1 i32)
  local.get $0
  global.get $~lib/rt/itcms/iter
  i32.eq
  if
   local.get $0
   call $~lib/rt/itcms/Object#get:prev
   local.tee $1
   i32.eqz
   if (result i32)
    i32.const 0
    i32.const 288
    i32.const 148
    i32.const 30
    call $~lib/builtins/abort
    unreachable
   else
    local.get $1
   end
   global.set $~lib/rt/itcms/iter
  end
  local.get $0
  call $~lib/rt/itcms/Object#unlink
  local.get $0
  global.get $~lib/rt/itcms/toSpace
  local.get $0
  call $~lib/rt/itcms/Object#get:isPointerfree
  if (result i32)
   global.get $~lib/rt/itcms/white
   i32.eqz
  else
   i32.const 2
  end
  call $~lib/rt/itcms/Object#linkTo
 )
 (func $~lib/rt/itcms/__visit (param $0 i32) (param $1 i32)
  (local $2 i32)
  local.get $0
  i32.eqz
  if
   return
  end
  local.get $0
  i32.const 20
  i32.sub
  local.set $2
  i32.const 0
  drop
  local.get $2
  call $~lib/rt/itcms/Object#get:color
  global.get $~lib/rt/itcms/white
  i32.eq
  if
   local.get $2
   call $~lib/rt/itcms/Object#makeGray
   global.get $~lib/rt/itcms/visitCount
   i32.const 1
   i32.add
   global.set $~lib/rt/itcms/visitCount
  end
 )
 (func $~lib/rt/itcms/visitStack (param $0 i32)
  (local $1 i32)
  global.get $~lib/memory/__stack_pointer
  local.set $1
  loop $while-continue|0
   local.get $1
   global.get $~lib/memory/__heap_base
   i32.lt_u
   if
    local.get $1
    i32.load
    local.get $0
    call $~lib/rt/itcms/__visit
    local.get $1
    i32.const 4
    i32.add
    local.set $1
    br $while-continue|0
   end
  end
 )
 (func $~lib/rt/common/BLOCK#get:mmInfo (param $0 i32) (result i32)
  local.get $0
  i32.load
 )
 (func $~lib/rt/itcms/Object#get:size (param $0 i32) (result i32)
  i32.const 4
  local.get $0
  call $~lib/rt/common/BLOCK#get:mmInfo
  i32.const 3
  i32.const -1
  i32.xor
  i32.and
  i32.add
  return
 )
 (func $~lib/rt/tlsf/Root#set:flMap (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store
 )
 (func $~lib/rt/common/BLOCK#set:mmInfo (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store
 )
 (func $~lib/rt/tlsf/Block#set:prev (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store offset=4
 )
 (func $~lib/rt/tlsf/Block#set:next (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store offset=8
 )
 (func $~lib/rt/tlsf/Block#get:prev (param $0 i32) (result i32)
  local.get $0
  i32.load offset=4
 )
 (func $~lib/rt/tlsf/Block#get:next (param $0 i32) (result i32)
  local.get $0
  i32.load offset=8
 )
 (func $~lib/rt/tlsf/Root#get:flMap (param $0 i32) (result i32)
  local.get $0
  i32.load
 )
 (func $~lib/rt/tlsf/removeBlock (param $0 i32) (param $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  (local $17 i32)
  (local $18 i32)
  (local $19 i32)
  (local $20 i32)
  (local $21 i32)
  (local $22 i32)
  (local $23 i32)
  local.get $1
  call $~lib/rt/common/BLOCK#get:mmInfo
  local.set $2
  i32.const 1
  drop
  local.get $2
  i32.const 1
  i32.and
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 268
   i32.const 14
   call $~lib/builtins/abort
   unreachable
  end
  local.get $2
  i32.const 3
  i32.const -1
  i32.xor
  i32.and
  local.set $3
  i32.const 1
  drop
  local.get $3
  i32.const 12
  i32.ge_u
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 270
   i32.const 14
   call $~lib/builtins/abort
   unreachable
  end
  local.get $3
  i32.const 256
  i32.lt_u
  if
   i32.const 0
   local.set $4
   local.get $3
   i32.const 4
   i32.shr_u
   local.set $5
  else
   local.get $3
   local.tee $6
   i32.const 1073741820
   local.tee $7
   local.get $6
   local.get $7
   i32.lt_u
   select
   local.set $8
   i32.const 31
   local.get $8
   i32.clz
   i32.sub
   local.set $4
   local.get $8
   local.get $4
   i32.const 4
   i32.sub
   i32.shr_u
   i32.const 1
   i32.const 4
   i32.shl
   i32.xor
   local.set $5
   local.get $4
   i32.const 8
   i32.const 1
   i32.sub
   i32.sub
   local.set $4
  end
  i32.const 1
  drop
  local.get $4
  i32.const 23
  i32.lt_u
  if (result i32)
   local.get $5
   i32.const 16
   i32.lt_u
  else
   i32.const 0
  end
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 284
   i32.const 14
   call $~lib/builtins/abort
   unreachable
  end
  local.get $1
  call $~lib/rt/tlsf/Block#get:prev
  local.set $9
  local.get $1
  call $~lib/rt/tlsf/Block#get:next
  local.set $10
  local.get $9
  if
   local.get $9
   local.get $10
   call $~lib/rt/tlsf/Block#set:next
  end
  local.get $10
  if
   local.get $10
   local.get $9
   call $~lib/rt/tlsf/Block#set:prev
  end
  local.get $1
  block $~lib/rt/tlsf/GETHEAD|inlined.0 (result i32)
   local.get $0
   local.set $11
   local.get $4
   local.set $12
   local.get $5
   local.set $13
   local.get $11
   local.get $12
   i32.const 4
   i32.shl
   local.get $13
   i32.add
   i32.const 2
   i32.shl
   i32.add
   i32.load offset=96
   br $~lib/rt/tlsf/GETHEAD|inlined.0
  end
  i32.eq
  if
   local.get $0
   local.set $14
   local.get $4
   local.set $15
   local.get $5
   local.set $16
   local.get $10
   local.set $17
   local.get $14
   local.get $15
   i32.const 4
   i32.shl
   local.get $16
   i32.add
   i32.const 2
   i32.shl
   i32.add
   local.get $17
   i32.store offset=96
   local.get $10
   i32.eqz
   if
    block $~lib/rt/tlsf/GETSL|inlined.0 (result i32)
     local.get $0
     local.set $18
     local.get $4
     local.set $19
     local.get $18
     local.get $19
     i32.const 2
     i32.shl
     i32.add
     i32.load offset=4
     br $~lib/rt/tlsf/GETSL|inlined.0
    end
    local.set $20
    local.get $0
    local.set $21
    local.get $4
    local.set $22
    local.get $20
    i32.const 1
    local.get $5
    i32.shl
    i32.const -1
    i32.xor
    i32.and
    local.tee $20
    local.set $23
    local.get $21
    local.get $22
    i32.const 2
    i32.shl
    i32.add
    local.get $23
    i32.store offset=4
    local.get $20
    i32.eqz
    if
     local.get $0
     local.get $0
     call $~lib/rt/tlsf/Root#get:flMap
     i32.const 1
     local.get $4
     i32.shl
     i32.const -1
     i32.xor
     i32.and
     call $~lib/rt/tlsf/Root#set:flMap
    end
   end
  end
 )
 (func $~lib/rt/tlsf/insertBlock (param $0 i32) (param $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  (local $17 i32)
  (local $18 i32)
  (local $19 i32)
  (local $20 i32)
  (local $21 i32)
  (local $22 i32)
  (local $23 i32)
  (local $24 i32)
  (local $25 i32)
  (local $26 i32)
  (local $27 i32)
  (local $28 i32)
  i32.const 1
  drop
  local.get $1
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 201
   i32.const 14
   call $~lib/builtins/abort
   unreachable
  end
  local.get $1
  call $~lib/rt/common/BLOCK#get:mmInfo
  local.set $2
  i32.const 1
  drop
  local.get $2
  i32.const 1
  i32.and
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 203
   i32.const 14
   call $~lib/builtins/abort
   unreachable
  end
  block $~lib/rt/tlsf/GETRIGHT|inlined.0 (result i32)
   local.get $1
   local.set $3
   local.get $3
   i32.const 4
   i32.add
   local.get $3
   call $~lib/rt/common/BLOCK#get:mmInfo
   i32.const 3
   i32.const -1
   i32.xor
   i32.and
   i32.add
   br $~lib/rt/tlsf/GETRIGHT|inlined.0
  end
  local.set $4
  local.get $4
  call $~lib/rt/common/BLOCK#get:mmInfo
  local.set $5
  local.get $5
  i32.const 1
  i32.and
  if
   local.get $0
   local.get $4
   call $~lib/rt/tlsf/removeBlock
   local.get $1
   local.get $2
   i32.const 4
   i32.add
   local.get $5
   i32.const 3
   i32.const -1
   i32.xor
   i32.and
   i32.add
   local.tee $2
   call $~lib/rt/common/BLOCK#set:mmInfo
   block $~lib/rt/tlsf/GETRIGHT|inlined.1 (result i32)
    local.get $1
    local.set $6
    local.get $6
    i32.const 4
    i32.add
    local.get $6
    call $~lib/rt/common/BLOCK#get:mmInfo
    i32.const 3
    i32.const -1
    i32.xor
    i32.and
    i32.add
    br $~lib/rt/tlsf/GETRIGHT|inlined.1
   end
   local.set $4
   local.get $4
   call $~lib/rt/common/BLOCK#get:mmInfo
   local.set $5
  end
  local.get $2
  i32.const 2
  i32.and
  if
   block $~lib/rt/tlsf/GETFREELEFT|inlined.0 (result i32)
    local.get $1
    local.set $7
    local.get $7
    i32.const 4
    i32.sub
    i32.load
    br $~lib/rt/tlsf/GETFREELEFT|inlined.0
   end
   local.set $8
   local.get $8
   call $~lib/rt/common/BLOCK#get:mmInfo
   local.set $9
   i32.const 1
   drop
   local.get $9
   i32.const 1
   i32.and
   i32.eqz
   if
    i32.const 0
    i32.const 560
    i32.const 221
    i32.const 16
    call $~lib/builtins/abort
    unreachable
   end
   local.get $0
   local.get $8
   call $~lib/rt/tlsf/removeBlock
   local.get $8
   local.set $1
   local.get $1
   local.get $9
   i32.const 4
   i32.add
   local.get $2
   i32.const 3
   i32.const -1
   i32.xor
   i32.and
   i32.add
   local.tee $2
   call $~lib/rt/common/BLOCK#set:mmInfo
  end
  local.get $4
  local.get $5
  i32.const 2
  i32.or
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $2
  i32.const 3
  i32.const -1
  i32.xor
  i32.and
  local.set $10
  i32.const 1
  drop
  local.get $10
  i32.const 12
  i32.ge_u
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 233
   i32.const 14
   call $~lib/builtins/abort
   unreachable
  end
  i32.const 1
  drop
  local.get $1
  i32.const 4
  i32.add
  local.get $10
  i32.add
  local.get $4
  i32.eq
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 234
   i32.const 14
   call $~lib/builtins/abort
   unreachable
  end
  local.get $4
  i32.const 4
  i32.sub
  local.get $1
  i32.store
  local.get $10
  i32.const 256
  i32.lt_u
  if
   i32.const 0
   local.set $11
   local.get $10
   i32.const 4
   i32.shr_u
   local.set $12
  else
   local.get $10
   local.tee $13
   i32.const 1073741820
   local.tee $14
   local.get $13
   local.get $14
   i32.lt_u
   select
   local.set $15
   i32.const 31
   local.get $15
   i32.clz
   i32.sub
   local.set $11
   local.get $15
   local.get $11
   i32.const 4
   i32.sub
   i32.shr_u
   i32.const 1
   i32.const 4
   i32.shl
   i32.xor
   local.set $12
   local.get $11
   i32.const 8
   i32.const 1
   i32.sub
   i32.sub
   local.set $11
  end
  i32.const 1
  drop
  local.get $11
  i32.const 23
  i32.lt_u
  if (result i32)
   local.get $12
   i32.const 16
   i32.lt_u
  else
   i32.const 0
  end
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 251
   i32.const 14
   call $~lib/builtins/abort
   unreachable
  end
  block $~lib/rt/tlsf/GETHEAD|inlined.1 (result i32)
   local.get $0
   local.set $16
   local.get $11
   local.set $17
   local.get $12
   local.set $18
   local.get $16
   local.get $17
   i32.const 4
   i32.shl
   local.get $18
   i32.add
   i32.const 2
   i32.shl
   i32.add
   i32.load offset=96
   br $~lib/rt/tlsf/GETHEAD|inlined.1
  end
  local.set $19
  local.get $1
  i32.const 0
  call $~lib/rt/tlsf/Block#set:prev
  local.get $1
  local.get $19
  call $~lib/rt/tlsf/Block#set:next
  local.get $19
  if
   local.get $19
   local.get $1
   call $~lib/rt/tlsf/Block#set:prev
  end
  local.get $0
  local.set $20
  local.get $11
  local.set $21
  local.get $12
  local.set $22
  local.get $1
  local.set $23
  local.get $20
  local.get $21
  i32.const 4
  i32.shl
  local.get $22
  i32.add
  i32.const 2
  i32.shl
  i32.add
  local.get $23
  i32.store offset=96
  local.get $0
  local.get $0
  call $~lib/rt/tlsf/Root#get:flMap
  i32.const 1
  local.get $11
  i32.shl
  i32.or
  call $~lib/rt/tlsf/Root#set:flMap
  local.get $0
  local.set $26
  local.get $11
  local.set $27
  block $~lib/rt/tlsf/GETSL|inlined.1 (result i32)
   local.get $0
   local.set $24
   local.get $11
   local.set $25
   local.get $24
   local.get $25
   i32.const 2
   i32.shl
   i32.add
   i32.load offset=4
   br $~lib/rt/tlsf/GETSL|inlined.1
  end
  i32.const 1
  local.get $12
  i32.shl
  i32.or
  local.set $28
  local.get $26
  local.get $27
  i32.const 2
  i32.shl
  i32.add
  local.get $28
  i32.store offset=4
 )
 (func $~lib/rt/tlsf/addMemory (param $0 i32) (param $1 i32) (param $2 i64) (result i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  local.get $2
  i32.wrap_i64
  local.set $3
  i32.const 1
  drop
  local.get $1
  i64.extend_i32_u
  local.get $2
  i64.le_u
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 382
   i32.const 14
   call $~lib/builtins/abort
   unreachable
  end
  local.get $1
  i32.const 4
  i32.add
  i32.const 15
  i32.add
  i32.const 15
  i32.const -1
  i32.xor
  i32.and
  i32.const 4
  i32.sub
  local.set $1
  local.get $3
  i32.const 15
  i32.const -1
  i32.xor
  i32.and
  local.set $3
  block $~lib/rt/tlsf/GETTAIL|inlined.0 (result i32)
   local.get $0
   local.set $4
   local.get $4
   i32.load offset=1568
   br $~lib/rt/tlsf/GETTAIL|inlined.0
  end
  local.set $5
  i32.const 0
  local.set $6
  local.get $5
  if
   i32.const 1
   drop
   local.get $1
   local.get $5
   i32.const 4
   i32.add
   i32.ge_u
   i32.eqz
   if
    i32.const 0
    i32.const 560
    i32.const 389
    i32.const 16
    call $~lib/builtins/abort
    unreachable
   end
   local.get $1
   i32.const 16
   i32.sub
   local.get $5
   i32.eq
   if
    local.get $1
    i32.const 16
    i32.sub
    local.set $1
    local.get $5
    call $~lib/rt/common/BLOCK#get:mmInfo
    local.set $6
   else
   end
  else
   i32.const 1
   drop
   local.get $1
   local.get $0
   i32.const 1572
   i32.add
   i32.ge_u
   i32.eqz
   if
    i32.const 0
    i32.const 560
    i32.const 402
    i32.const 5
    call $~lib/builtins/abort
    unreachable
   end
  end
  local.get $3
  local.get $1
  i32.sub
  local.set $7
  local.get $7
  i32.const 4
  i32.const 12
  i32.add
  i32.const 4
  i32.add
  i32.lt_u
  if
   i32.const 0
   return
  end
  local.get $7
  i32.const 2
  i32.const 4
  i32.mul
  i32.sub
  local.set $8
  local.get $1
  local.set $9
  local.get $9
  local.get $8
  i32.const 1
  i32.or
  local.get $6
  i32.const 2
  i32.and
  i32.or
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $9
  i32.const 0
  call $~lib/rt/tlsf/Block#set:prev
  local.get $9
  i32.const 0
  call $~lib/rt/tlsf/Block#set:next
  local.get $1
  i32.const 4
  i32.add
  local.get $8
  i32.add
  local.set $5
  local.get $5
  i32.const 0
  i32.const 2
  i32.or
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  local.set $10
  local.get $5
  local.set $11
  local.get $10
  local.get $11
  i32.store offset=1568
  local.get $0
  local.get $9
  call $~lib/rt/tlsf/insertBlock
  i32.const 1
  return
 )
 (func $~lib/rt/tlsf/initialize
  (local $0 i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  i32.const 0
  drop
  global.get $~lib/memory/__heap_base
  i32.const 15
  i32.add
  i32.const 15
  i32.const -1
  i32.xor
  i32.and
  local.set $0
  memory.size
  local.set $1
  local.get $0
  i32.const 1572
  i32.add
  i32.const 65535
  i32.add
  i32.const 65535
  i32.const -1
  i32.xor
  i32.and
  i32.const 16
  i32.shr_u
  local.set $2
  local.get $2
  local.get $1
  i32.gt_s
  if (result i32)
   local.get $2
   local.get $1
   i32.sub
   memory.grow
   i32.const 0
   i32.lt_s
  else
   i32.const 0
  end
  if
   unreachable
  end
  local.get $0
  local.set $3
  local.get $3
  i32.const 0
  call $~lib/rt/tlsf/Root#set:flMap
  local.get $3
  local.set $4
  i32.const 0
  local.set $5
  local.get $4
  local.get $5
  i32.store offset=1568
  i32.const 0
  local.set $6
  loop $for-loop|0
   local.get $6
   i32.const 23
   i32.lt_u
   if
    local.get $3
    local.set $7
    local.get $6
    local.set $8
    i32.const 0
    local.set $9
    local.get $7
    local.get $8
    i32.const 2
    i32.shl
    i32.add
    local.get $9
    i32.store offset=4
    i32.const 0
    local.set $10
    loop $for-loop|1
     local.get $10
     i32.const 16
     i32.lt_u
     if
      local.get $3
      local.set $11
      local.get $6
      local.set $12
      local.get $10
      local.set $13
      i32.const 0
      local.set $14
      local.get $11
      local.get $12
      i32.const 4
      i32.shl
      local.get $13
      i32.add
      i32.const 2
      i32.shl
      i32.add
      local.get $14
      i32.store offset=96
      local.get $10
      i32.const 1
      i32.add
      local.set $10
      br $for-loop|1
     end
    end
    local.get $6
    i32.const 1
    i32.add
    local.set $6
    br $for-loop|0
   end
  end
  local.get $0
  i32.const 1572
  i32.add
  local.set $15
  i32.const 0
  drop
  local.get $3
  local.get $15
  memory.size
  i64.extend_i32_s
  i64.const 16
  i64.shl
  call $~lib/rt/tlsf/addMemory
  drop
  local.get $3
  global.set $~lib/rt/tlsf/ROOT
 )
 (func $~lib/rt/tlsf/checkUsedBlock (param $0 i32) (result i32)
  (local $1 i32)
  local.get $0
  i32.const 4
  i32.sub
  local.set $1
  local.get $0
  i32.const 0
  i32.ne
  if (result i32)
   local.get $0
   i32.const 15
   i32.and
   i32.eqz
  else
   i32.const 0
  end
  if (result i32)
   local.get $1
   call $~lib/rt/common/BLOCK#get:mmInfo
   i32.const 1
   i32.and
   i32.eqz
  else
   i32.const 0
  end
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 562
   i32.const 3
   call $~lib/builtins/abort
   unreachable
  end
  local.get $1
  return
 )
 (func $~lib/rt/tlsf/freeBlock (param $0 i32) (param $1 i32)
  i32.const 0
  drop
  local.get $1
  local.get $1
  call $~lib/rt/common/BLOCK#get:mmInfo
  i32.const 1
  i32.or
  call $~lib/rt/common/BLOCK#set:mmInfo
  local.get $0
  local.get $1
  call $~lib/rt/tlsf/insertBlock
 )
 (func $~lib/rt/tlsf/__free (param $0 i32)
  local.get $0
  global.get $~lib/memory/__heap_base
  i32.lt_u
  if
   return
  end
  global.get $~lib/rt/tlsf/ROOT
  i32.eqz
  if
   call $~lib/rt/tlsf/initialize
  end
  global.get $~lib/rt/tlsf/ROOT
  local.get $0
  call $~lib/rt/tlsf/checkUsedBlock
  call $~lib/rt/tlsf/freeBlock
 )
 (func $~lib/rt/itcms/free (param $0 i32)
  local.get $0
  global.get $~lib/memory/__heap_base
  i32.lt_u
  if
   local.get $0
   i32.const 0
   call $~lib/rt/itcms/Object#set:nextWithColor
   local.get $0
   i32.const 0
   call $~lib/rt/itcms/Object#set:prev
  else
   global.get $~lib/rt/itcms/total
   local.get $0
   call $~lib/rt/itcms/Object#get:size
   i32.sub
   global.set $~lib/rt/itcms/total
   i32.const 0
   drop
   local.get $0
   i32.const 4
   i32.add
   call $~lib/rt/tlsf/__free
  end
 )
 (func $~lib/rt/itcms/step (result i32)
  (local $0 i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  block $break|0
   block $case2|0
    block $case1|0
     block $case0|0
      global.get $~lib/rt/itcms/state
      local.set $1
      local.get $1
      i32.const 0
      i32.eq
      br_if $case0|0
      local.get $1
      i32.const 1
      i32.eq
      br_if $case1|0
      local.get $1
      i32.const 2
      i32.eq
      br_if $case2|0
      br $break|0
     end
     i32.const 1
     global.set $~lib/rt/itcms/state
     i32.const 0
     global.set $~lib/rt/itcms/visitCount
     i32.const 0
     call $~lib/rt/itcms/visitRoots
     global.get $~lib/rt/itcms/toSpace
     global.set $~lib/rt/itcms/iter
     global.get $~lib/rt/itcms/visitCount
     i32.const 1
     i32.mul
     return
    end
    global.get $~lib/rt/itcms/white
    i32.eqz
    local.set $2
    global.get $~lib/rt/itcms/iter
    call $~lib/rt/itcms/Object#get:next
    local.set $0
    loop $while-continue|1
     local.get $0
     global.get $~lib/rt/itcms/toSpace
     i32.ne
     if
      local.get $0
      global.set $~lib/rt/itcms/iter
      local.get $0
      call $~lib/rt/itcms/Object#get:color
      local.get $2
      i32.ne
      if
       local.get $0
       local.get $2
       call $~lib/rt/itcms/Object#set:color
       i32.const 0
       global.set $~lib/rt/itcms/visitCount
       local.get $0
       i32.const 20
       i32.add
       i32.const 0
       call $~lib/rt/__visit_members
       global.get $~lib/rt/itcms/visitCount
       i32.const 1
       i32.mul
       return
      end
      local.get $0
      call $~lib/rt/itcms/Object#get:next
      local.set $0
      br $while-continue|1
     end
    end
    i32.const 0
    global.set $~lib/rt/itcms/visitCount
    i32.const 0
    call $~lib/rt/itcms/visitRoots
    global.get $~lib/rt/itcms/iter
    call $~lib/rt/itcms/Object#get:next
    local.set $0
    local.get $0
    global.get $~lib/rt/itcms/toSpace
    i32.eq
    if
     i32.const 0
     call $~lib/rt/itcms/visitStack
     global.get $~lib/rt/itcms/iter
     call $~lib/rt/itcms/Object#get:next
     local.set $0
     loop $while-continue|2
      local.get $0
      global.get $~lib/rt/itcms/toSpace
      i32.ne
      if
       local.get $0
       call $~lib/rt/itcms/Object#get:color
       local.get $2
       i32.ne
       if
        local.get $0
        local.get $2
        call $~lib/rt/itcms/Object#set:color
        local.get $0
        i32.const 20
        i32.add
        i32.const 0
        call $~lib/rt/__visit_members
       end
       local.get $0
       call $~lib/rt/itcms/Object#get:next
       local.set $0
       br $while-continue|2
      end
     end
     global.get $~lib/rt/itcms/fromSpace
     local.set $3
     global.get $~lib/rt/itcms/toSpace
     global.set $~lib/rt/itcms/fromSpace
     local.get $3
     global.set $~lib/rt/itcms/toSpace
     local.get $2
     global.set $~lib/rt/itcms/white
     local.get $3
     call $~lib/rt/itcms/Object#get:next
     global.set $~lib/rt/itcms/iter
     i32.const 2
     global.set $~lib/rt/itcms/state
    end
    global.get $~lib/rt/itcms/visitCount
    i32.const 1
    i32.mul
    return
   end
   global.get $~lib/rt/itcms/iter
   local.set $0
   local.get $0
   global.get $~lib/rt/itcms/toSpace
   i32.ne
   if
    local.get $0
    call $~lib/rt/itcms/Object#get:next
    global.set $~lib/rt/itcms/iter
    i32.const 1
    drop
    local.get $0
    call $~lib/rt/itcms/Object#get:color
    global.get $~lib/rt/itcms/white
    i32.eqz
    i32.eq
    i32.eqz
    if
     i32.const 0
     i32.const 288
     i32.const 229
     i32.const 20
     call $~lib/builtins/abort
     unreachable
    end
    local.get $0
    call $~lib/rt/itcms/free
    i32.const 10
    return
   end
   global.get $~lib/rt/itcms/toSpace
   global.get $~lib/rt/itcms/toSpace
   call $~lib/rt/itcms/Object#set:nextWithColor
   global.get $~lib/rt/itcms/toSpace
   global.get $~lib/rt/itcms/toSpace
   call $~lib/rt/itcms/Object#set:prev
   i32.const 0
   global.set $~lib/rt/itcms/state
   br $break|0
  end
  i32.const 0
  return
 )
 (func $~lib/rt/itcms/interrupt
  (local $0 i32)
  i32.const 0
  drop
  i32.const 0
  drop
  i32.const 1024
  i32.const 200
  i32.mul
  i32.const 100
  i32.div_u
  local.set $0
  loop $do-loop|0
   local.get $0
   call $~lib/rt/itcms/step
   i32.sub
   local.set $0
   global.get $~lib/rt/itcms/state
   i32.const 0
   i32.eq
   if
    i32.const 0
    drop
    i32.const 200
    i32.const 100
    i32.rem_u
    i32.const 0
    i32.eq
    drop
    global.get $~lib/rt/itcms/total
    i32.const 200
    i32.const 100
    i32.div_u
    i32.mul
    i32.const 1024
    i32.add
    global.set $~lib/rt/itcms/threshold
    i32.const 0
    drop
    return
   end
   local.get $0
   i32.const 0
   i32.gt_s
   br_if $do-loop|0
  end
  i32.const 0
  drop
  global.get $~lib/rt/itcms/total
  i32.const 1024
  global.get $~lib/rt/itcms/total
  global.get $~lib/rt/itcms/threshold
  i32.sub
  i32.const 1024
  i32.lt_u
  i32.mul
  i32.add
  global.set $~lib/rt/itcms/threshold
  i32.const 0
  drop
 )
 (func $~lib/rt/tlsf/computeSize (param $0 i32) (result i32)
  local.get $0
  i32.const 12
  i32.le_u
  if (result i32)
   i32.const 12
  else
   local.get $0
   i32.const 4
   i32.add
   i32.const 15
   i32.add
   i32.const 15
   i32.const -1
   i32.xor
   i32.and
   i32.const 4
   i32.sub
  end
  return
 )
 (func $~lib/rt/tlsf/prepareSize (param $0 i32) (result i32)
  local.get $0
  i32.const 1073741820
  i32.gt_u
  if
   i32.const 224
   i32.const 560
   i32.const 461
   i32.const 29
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  call $~lib/rt/tlsf/computeSize
  return
 )
 (func $~lib/rt/tlsf/roundSize (param $0 i32) (result i32)
  local.get $0
  i32.const 536870910
  i32.lt_u
  if (result i32)
   local.get $0
   i32.const 1
   i32.const 27
   local.get $0
   i32.clz
   i32.sub
   i32.shl
   i32.add
   i32.const 1
   i32.sub
  else
   local.get $0
  end
  return
 )
 (func $~lib/rt/tlsf/searchBlock (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  (local $12 i32)
  (local $13 i32)
  (local $14 i32)
  (local $15 i32)
  (local $16 i32)
  (local $17 i32)
  local.get $1
  i32.const 256
  i32.lt_u
  if
   i32.const 0
   local.set $2
   local.get $1
   i32.const 4
   i32.shr_u
   local.set $3
  else
   local.get $1
   call $~lib/rt/tlsf/roundSize
   local.set $4
   i32.const 4
   i32.const 8
   i32.mul
   i32.const 1
   i32.sub
   local.get $4
   i32.clz
   i32.sub
   local.set $2
   local.get $4
   local.get $2
   i32.const 4
   i32.sub
   i32.shr_u
   i32.const 1
   i32.const 4
   i32.shl
   i32.xor
   local.set $3
   local.get $2
   i32.const 8
   i32.const 1
   i32.sub
   i32.sub
   local.set $2
  end
  i32.const 1
  drop
  local.get $2
  i32.const 23
  i32.lt_u
  if (result i32)
   local.get $3
   i32.const 16
   i32.lt_u
  else
   i32.const 0
  end
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 334
   i32.const 14
   call $~lib/builtins/abort
   unreachable
  end
  block $~lib/rt/tlsf/GETSL|inlined.2 (result i32)
   local.get $0
   local.set $5
   local.get $2
   local.set $6
   local.get $5
   local.get $6
   i32.const 2
   i32.shl
   i32.add
   i32.load offset=4
   br $~lib/rt/tlsf/GETSL|inlined.2
  end
  i32.const 0
  i32.const -1
  i32.xor
  local.get $3
  i32.shl
  i32.and
  local.set $7
  i32.const 0
  local.set $8
  local.get $7
  i32.eqz
  if
   local.get $0
   call $~lib/rt/tlsf/Root#get:flMap
   i32.const 0
   i32.const -1
   i32.xor
   local.get $2
   i32.const 1
   i32.add
   i32.shl
   i32.and
   local.set $9
   local.get $9
   i32.eqz
   if
    i32.const 0
    local.set $8
   else
    local.get $9
    i32.ctz
    local.set $2
    block $~lib/rt/tlsf/GETSL|inlined.3 (result i32)
     local.get $0
     local.set $10
     local.get $2
     local.set $11
     local.get $10
     local.get $11
     i32.const 2
     i32.shl
     i32.add
     i32.load offset=4
     br $~lib/rt/tlsf/GETSL|inlined.3
    end
    local.set $7
    i32.const 1
    drop
    local.get $7
    i32.eqz
    if
     i32.const 0
     i32.const 560
     i32.const 347
     i32.const 18
     call $~lib/builtins/abort
     unreachable
    end
    block $~lib/rt/tlsf/GETHEAD|inlined.2 (result i32)
     local.get $0
     local.set $12
     local.get $2
     local.set $13
     local.get $7
     i32.ctz
     local.set $14
     local.get $12
     local.get $13
     i32.const 4
     i32.shl
     local.get $14
     i32.add
     i32.const 2
     i32.shl
     i32.add
     i32.load offset=96
     br $~lib/rt/tlsf/GETHEAD|inlined.2
    end
    local.set $8
   end
  else
   block $~lib/rt/tlsf/GETHEAD|inlined.3 (result i32)
    local.get $0
    local.set $15
    local.get $2
    local.set $16
    local.get $7
    i32.ctz
    local.set $17
    local.get $15
    local.get $16
    i32.const 4
    i32.shl
    local.get $17
    i32.add
    i32.const 2
    i32.shl
    i32.add
    i32.load offset=96
    br $~lib/rt/tlsf/GETHEAD|inlined.3
   end
   local.set $8
  end
  local.get $8
  return
 )
 (func $~lib/rt/tlsf/growMemory (param $0 i32) (param $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  i32.const 0
  drop
  local.get $1
  i32.const 256
  i32.ge_u
  if
   local.get $1
   call $~lib/rt/tlsf/roundSize
   local.set $1
  end
  memory.size
  local.set $2
  local.get $1
  i32.const 4
  local.get $2
  i32.const 16
  i32.shl
  i32.const 4
  i32.sub
  block $~lib/rt/tlsf/GETTAIL|inlined.1 (result i32)
   local.get $0
   local.set $3
   local.get $3
   i32.load offset=1568
   br $~lib/rt/tlsf/GETTAIL|inlined.1
  end
  i32.ne
  i32.shl
  i32.add
  local.set $1
  local.get $1
  i32.const 65535
  i32.add
  i32.const 65535
  i32.const -1
  i32.xor
  i32.and
  i32.const 16
  i32.shr_u
  local.set $4
  local.get $2
  local.tee $5
  local.get $4
  local.tee $6
  local.get $5
  local.get $6
  i32.gt_s
  select
  local.set $7
  local.get $7
  memory.grow
  i32.const 0
  i32.lt_s
  if
   local.get $4
   memory.grow
   i32.const 0
   i32.lt_s
   if
    unreachable
   end
  end
  memory.size
  local.set $8
  local.get $0
  local.get $2
  i32.const 16
  i32.shl
  local.get $8
  i64.extend_i32_s
  i64.const 16
  i64.shl
  call $~lib/rt/tlsf/addMemory
  drop
 )
 (func $~lib/rt/tlsf/prepareBlock (param $0 i32) (param $1 i32) (param $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  local.get $1
  call $~lib/rt/common/BLOCK#get:mmInfo
  local.set $3
  i32.const 1
  drop
  local.get $2
  i32.const 4
  i32.add
  i32.const 15
  i32.and
  i32.eqz
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 361
   i32.const 14
   call $~lib/builtins/abort
   unreachable
  end
  local.get $3
  i32.const 3
  i32.const -1
  i32.xor
  i32.and
  local.get $2
  i32.sub
  local.set $4
  local.get $4
  i32.const 4
  i32.const 12
  i32.add
  i32.ge_u
  if
   local.get $1
   local.get $2
   local.get $3
   i32.const 2
   i32.and
   i32.or
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $1
   i32.const 4
   i32.add
   local.get $2
   i32.add
   local.set $5
   local.get $5
   local.get $4
   i32.const 4
   i32.sub
   i32.const 1
   i32.or
   call $~lib/rt/common/BLOCK#set:mmInfo
   local.get $0
   local.get $5
   call $~lib/rt/tlsf/insertBlock
  else
   local.get $1
   local.get $3
   i32.const 1
   i32.const -1
   i32.xor
   i32.and
   call $~lib/rt/common/BLOCK#set:mmInfo
   block $~lib/rt/tlsf/GETRIGHT|inlined.3 (result i32)
    local.get $1
    local.set $7
    local.get $7
    i32.const 4
    i32.add
    local.get $7
    call $~lib/rt/common/BLOCK#get:mmInfo
    i32.const 3
    i32.const -1
    i32.xor
    i32.and
    i32.add
    br $~lib/rt/tlsf/GETRIGHT|inlined.3
   end
   block $~lib/rt/tlsf/GETRIGHT|inlined.2 (result i32)
    local.get $1
    local.set $6
    local.get $6
    i32.const 4
    i32.add
    local.get $6
    call $~lib/rt/common/BLOCK#get:mmInfo
    i32.const 3
    i32.const -1
    i32.xor
    i32.and
    i32.add
    br $~lib/rt/tlsf/GETRIGHT|inlined.2
   end
   call $~lib/rt/common/BLOCK#get:mmInfo
   i32.const 2
   i32.const -1
   i32.xor
   i32.and
   call $~lib/rt/common/BLOCK#set:mmInfo
  end
 )
 (func $~lib/rt/tlsf/allocateBlock (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $1
  call $~lib/rt/tlsf/prepareSize
  local.set $2
  local.get $0
  local.get $2
  call $~lib/rt/tlsf/searchBlock
  local.set $3
  local.get $3
  i32.eqz
  if
   local.get $0
   local.get $2
   call $~lib/rt/tlsf/growMemory
   local.get $0
   local.get $2
   call $~lib/rt/tlsf/searchBlock
   local.set $3
   i32.const 1
   drop
   local.get $3
   i32.eqz
   if
    i32.const 0
    i32.const 560
    i32.const 499
    i32.const 16
    call $~lib/builtins/abort
    unreachable
   end
  end
  i32.const 1
  drop
  local.get $3
  call $~lib/rt/common/BLOCK#get:mmInfo
  i32.const 3
  i32.const -1
  i32.xor
  i32.and
  local.get $2
  i32.ge_u
  i32.eqz
  if
   i32.const 0
   i32.const 560
   i32.const 501
   i32.const 14
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  local.get $3
  call $~lib/rt/tlsf/removeBlock
  local.get $0
  local.get $3
  local.get $2
  call $~lib/rt/tlsf/prepareBlock
  i32.const 0
  drop
  local.get $3
  return
 )
 (func $~lib/rt/tlsf/__alloc (param $0 i32) (result i32)
  global.get $~lib/rt/tlsf/ROOT
  i32.eqz
  if
   call $~lib/rt/tlsf/initialize
  end
  global.get $~lib/rt/tlsf/ROOT
  local.get $0
  call $~lib/rt/tlsf/allocateBlock
  i32.const 4
  i32.add
  return
 )
 (func $~lib/rt/itcms/Object#set:rtId (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store offset=12
 )
 (func $~lib/rt/itcms/Object#set:rtSize (param $0 i32) (param $1 i32)
  local.get $0
  local.get $1
  i32.store offset=16
 )
 (func $~lib/rt/itcms/__new (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  local.get $0
  i32.const 1073741804
  i32.ge_u
  if
   i32.const 224
   i32.const 288
   i32.const 261
   i32.const 31
   call $~lib/builtins/abort
   unreachable
  end
  global.get $~lib/rt/itcms/total
  global.get $~lib/rt/itcms/threshold
  i32.ge_u
  if
   call $~lib/rt/itcms/interrupt
  end
  i32.const 16
  local.get $0
  i32.add
  call $~lib/rt/tlsf/__alloc
  i32.const 4
  i32.sub
  local.set $2
  local.get $2
  local.get $1
  call $~lib/rt/itcms/Object#set:rtId
  local.get $2
  local.get $0
  call $~lib/rt/itcms/Object#set:rtSize
  local.get $2
  global.get $~lib/rt/itcms/fromSpace
  global.get $~lib/rt/itcms/white
  call $~lib/rt/itcms/Object#linkTo
  global.get $~lib/rt/itcms/total
  local.get $2
  call $~lib/rt/itcms/Object#get:size
  i32.add
  global.set $~lib/rt/itcms/total
  local.get $2
  i32.const 20
  i32.add
  local.set $3
  local.get $3
  i32.const 0
  local.get $0
  memory.fill
  local.get $3
  return
 )
 (func $~lib/rt/common/OBJECT#get:rtSize (param $0 i32) (result i32)
  local.get $0
  i32.load offset=16
 )
 (func $~lib/staticarray/StaticArray<i32>#get:length (param $0 i32) (result i32)
  local.get $0
  i32.const 20
  i32.sub
  call $~lib/rt/common/OBJECT#get:rtSize
  i32.const 2
  i32.shr_u
  return
 )
 (func $~lib/staticarray/StaticArray<f64>#get:length (param $0 i32) (result i32)
  local.get $0
  i32.const 20
  i32.sub
  call $~lib/rt/common/OBJECT#get:rtSize
  i32.const 3
  i32.shr_u
  return
 )
 (func $~lib/math/NativeMath.log (param $0 f64) (result f64)
  (local $1 f64)
  (local $2 i64)
  (local $3 f64)
  (local $4 f64)
  (local $5 f64)
  (local $6 f64)
  (local $7 f64)
  (local $8 f64)
  (local $9 f64)
  (local $10 f64)
  (local $11 f64)
  (local $12 i32)
  (local $13 i64)
  (local $14 i32)
  (local $15 i64)
  (local $16 i64)
  (local $17 f64)
  (local $18 f64)
  (local $19 f64)
  (local $20 f64)
  (local $21 f64)
  (local $22 f64)
  (local $23 f64)
  (local $24 f64)
  (local $25 f64)
  (local $26 f64)
  (local $27 f64)
  i32.const 0
  i32.const 1
  i32.lt_s
  drop
  block $~lib/util/math/log_lut|inlined.0 (result f64)
   local.get $0
   local.set $1
   local.get $1
   i64.reinterpret_f64
   local.set $2
   local.get $2
   i64.const 4606619468846596096
   i64.sub
   i64.const 4607473789381378048
   i64.const 4606619468846596096
   i64.sub
   i64.lt_u
   if
    local.get $1
    f64.const 1
    f64.sub
    local.set $3
    local.get $3
    local.get $3
    f64.mul
    local.set $4
    local.get $4
    local.get $3
    f64.mul
    local.set $5
    local.get $5
    f64.const 0.3333333333333352
    local.get $3
    f64.const -0.24999999999998432
    f64.mul
    f64.add
    local.get $4
    f64.const 0.19999999999320328
    f64.mul
    f64.add
    local.get $5
    f64.const -0.16666666669929706
    local.get $3
    f64.const 0.14285715076560868
    f64.mul
    f64.add
    local.get $4
    f64.const -0.12499997863982555
    f64.mul
    f64.add
    local.get $5
    f64.const 0.11110712032936046
    local.get $3
    f64.const -0.10000486757818193
    f64.mul
    f64.add
    local.get $4
    f64.const 0.09181994006195467
    f64.mul
    f64.add
    local.get $5
    f64.const -0.08328363062289341
    f64.mul
    f64.add
    f64.mul
    f64.add
    f64.mul
    f64.add
    f64.mul
    local.set $6
    local.get $3
    f64.const 134217728
    f64.mul
    local.set $7
    local.get $3
    local.get $7
    f64.add
    local.get $7
    f64.sub
    local.set $8
    local.get $3
    local.get $8
    f64.sub
    local.set $9
    local.get $8
    local.get $8
    f64.mul
    f64.const -0.5
    f64.mul
    local.set $7
    local.get $3
    local.get $7
    f64.add
    local.set $10
    local.get $3
    local.get $10
    f64.sub
    local.get $7
    f64.add
    local.set $11
    local.get $11
    f64.const -0.5
    local.get $9
    f64.mul
    local.get $8
    local.get $3
    f64.add
    f64.mul
    f64.add
    local.set $11
    local.get $6
    local.get $11
    f64.add
    local.get $10
    f64.add
    br $~lib/util/math/log_lut|inlined.0
   end
   local.get $2
   i64.const 48
   i64.shr_u
   i32.wrap_i64
   local.set $12
   local.get $12
   i32.const 16
   i32.sub
   i32.const 32752
   i32.const 16
   i32.sub
   i32.ge_u
   if
    local.get $2
    i64.const 1
    i64.shl
    i64.const 0
    i64.eq
    if
     f64.const -1
     local.get $1
     local.get $1
     f64.mul
     f64.div
     br $~lib/util/math/log_lut|inlined.0
    end
    local.get $2
    f64.const inf
    i64.reinterpret_f64
    i64.eq
    if
     local.get $1
     br $~lib/util/math/log_lut|inlined.0
    end
    local.get $12
    i32.const 32768
    i32.and
    if (result i32)
     i32.const 1
    else
     local.get $12
     i32.const 32752
     i32.and
     i32.const 32752
     i32.eq
    end
    if
     local.get $1
     local.get $1
     f64.sub
     local.get $1
     local.get $1
     f64.sub
     f64.div
     br $~lib/util/math/log_lut|inlined.0
    end
    local.get $1
    f64.const 4503599627370496
    f64.mul
    i64.reinterpret_f64
    local.set $2
    local.get $2
    i64.const 52
    i64.const 52
    i64.shl
    i64.sub
    local.set $2
   end
   local.get $2
   i64.const 4604367669032910848
   i64.sub
   local.set $13
   local.get $13
   i64.const 52
   i32.const 7
   i64.extend_i32_s
   i64.sub
   i64.shr_u
   i32.const 127
   i64.extend_i32_s
   i64.and
   i32.wrap_i64
   local.set $14
   local.get $13
   i64.const 52
   i64.shr_s
   local.set $15
   local.get $2
   local.get $13
   i64.const 4095
   i64.const 52
   i64.shl
   i64.and
   i64.sub
   local.set $16
   i32.const 720
   local.get $14
   i32.const 1
   i32.const 3
   i32.add
   i32.shl
   i32.add
   f64.load
   local.set $17
   i32.const 720
   local.get $14
   i32.const 1
   i32.const 3
   i32.add
   i32.shl
   i32.add
   f64.load offset=8
   local.set $18
   local.get $16
   f64.reinterpret_i64
   local.set $19
   i32.const 2768
   local.get $14
   i32.const 1
   i32.const 3
   i32.add
   i32.shl
   i32.add
   f64.load
   local.set $20
   i32.const 2768
   local.get $14
   i32.const 1
   i32.const 3
   i32.add
   i32.shl
   i32.add
   f64.load offset=8
   local.set $21
   local.get $19
   local.get $20
   f64.sub
   local.get $21
   f64.sub
   local.get $17
   f64.mul
   local.set $22
   local.get $15
   f64.convert_i64_s
   local.set $23
   local.get $23
   f64.const 0.6931471805598903
   f64.mul
   local.get $18
   f64.add
   local.set $24
   local.get $24
   local.get $22
   f64.add
   local.set $25
   local.get $24
   local.get $25
   f64.sub
   local.get $22
   f64.add
   local.get $23
   f64.const 5.497923018708371e-14
   f64.mul
   f64.add
   local.set $26
   local.get $22
   local.get $22
   f64.mul
   local.set $27
   local.get $26
   local.get $27
   f64.const -0.5000000000000001
   f64.mul
   f64.add
   local.get $22
   local.get $27
   f64.mul
   f64.const 0.33333333331825593
   local.get $22
   f64.const -0.2499999999622955
   f64.mul
   f64.add
   local.get $27
   f64.const 0.20000304511814496
   local.get $22
   f64.const -0.16667054827627667
   f64.mul
   f64.add
   f64.mul
   f64.add
   f64.mul
   f64.add
   local.get $25
   f64.add
   br $~lib/util/math/log_lut|inlined.0
  end
  return
 )
 (func $assembly/tensor_math/RNG#get:s (param $0 i32) (result i32)
  local.get $0
  i32.load
 )
 (func $~lib/math/dtoi32 (param $0 f64) (result i32)
  (local $1 i32)
  (local $2 i64)
  (local $3 i64)
  (local $4 i64)
  i32.const 0
  i32.const 0
  i32.gt_s
  drop
  i32.const 0
  local.set $1
  local.get $0
  i64.reinterpret_f64
  local.set $2
  local.get $2
  i64.const 52
  i64.shr_u
  i64.const 2047
  i64.and
  local.set $3
  local.get $3
  i64.const 1023
  i64.const 30
  i64.add
  i64.le_u
  if
   local.get $0
   i32.trunc_sat_f64_s
   local.set $1
  else
   local.get $3
   i64.const 1023
   i64.const 30
   i64.add
   i64.const 53
   i64.add
   i64.le_u
   if
    local.get $2
    i64.const 1
    i64.const 52
    i64.shl
    i64.const 1
    i64.sub
    i64.and
    i64.const 1
    i64.const 52
    i64.shl
    i64.or
    local.set $4
    local.get $4
    local.get $3
    i64.const 1023
    i64.sub
    i64.const 52
    i64.sub
    i64.const 32
    i64.add
    i64.shl
    local.set $4
    local.get $4
    i64.const 32
    i64.shr_u
    i32.wrap_i64
    local.set $1
    i32.const 0
    local.get $1
    i32.sub
    local.get $1
    local.get $2
    i64.const 0
    i64.lt_s
    select
    local.set $1
   end
  end
  local.get $1
  return
 )
 (func $~lib/math/NativeMath.imul (param $0 f64) (param $1 f64) (result f64)
  (local $2 f64)
  local.get $0
  local.get $1
  f64.add
  local.tee $2
  local.get $2
  f64.sub
  f64.const 0
  f64.eq
  i32.eqz
  if
   f64.const 0
   return
  end
  local.get $0
  call $~lib/math/dtoi32
  local.get $1
  call $~lib/math/dtoi32
  i32.mul
  f64.convert_i32_s
  return
 )
 (func $assembly/tensor_math/clamp (param $0 f64) (param $1 f64) (param $2 f64) (result f64)
  local.get $0
  local.get $1
  f64.lt
  if
   local.get $1
   return
  end
  local.get $0
  local.get $2
  f64.gt
  if
   local.get $2
   return
  end
  local.get $0
  return
 )
 (func $~lib/staticarray/StaticArray<i32>#__uset (param $0 i32) (param $1 i32) (param $2 i32)
  local.get $0
  local.get $1
  i32.const 2
  i32.shl
  i32.add
  local.get $2
  i32.store
  i32.const 0
  drop
 )
 (func $~lib/staticarray/StaticArray<f64>#__uset (param $0 i32) (param $1 i32) (param $2 f64)
  local.get $0
  local.get $1
  i32.const 3
  i32.shl
  i32.add
  local.get $2
  f64.store
  i32.const 0
  drop
 )
 (func $~lib/rt/__visit_globals (param $0 i32)
  (local $1 i32)
  i32.const 416
  local.get $0
  call $~lib/rt/itcms/__visit
  i32.const 624
  local.get $0
  call $~lib/rt/itcms/__visit
  i32.const 224
  local.get $0
  call $~lib/rt/itcms/__visit
 )
 (func $~lib/arraybuffer/ArrayBufferView~visit (param $0 i32) (param $1 i32)
  (local $2 i32)
  local.get $0
  local.get $1
  call $~lib/object/Object~visit
  local.get $0
  i32.load
  local.get $1
  call $~lib/rt/itcms/__visit
 )
 (func $~lib/object/Object~visit (param $0 i32) (param $1 i32)
 )
 (func $~lib/rt/__visit_members (param $0 i32) (param $1 i32)
  block $invalid
   block $~lib/staticarray/StaticArray<f64>
    block $~lib/staticarray/StaticArray<i32>
     block $assembly/tensor_math/RNG
      block $~lib/arraybuffer/ArrayBufferView
       block $~lib/string/String
        block $~lib/arraybuffer/ArrayBuffer
         block $~lib/object/Object
          local.get $0
          i32.const 8
          i32.sub
          i32.load
          br_table $~lib/object/Object $~lib/arraybuffer/ArrayBuffer $~lib/string/String $~lib/arraybuffer/ArrayBufferView $assembly/tensor_math/RNG $~lib/staticarray/StaticArray<i32> $~lib/staticarray/StaticArray<f64> $invalid
         end
         return
        end
        return
       end
       return
      end
      local.get $0
      local.get $1
      call $~lib/arraybuffer/ArrayBufferView~visit
      return
     end
     return
    end
    return
   end
   return
  end
  unreachable
 )
 (func $~start
  memory.size
  i32.const 16
  i32.shl
  global.get $~lib/memory/__heap_base
  i32.sub
  i32.const 1
  i32.shr_u
  global.set $~lib/rt/itcms/threshold
  i32.const 336
  call $~lib/rt/itcms/initLazy
  global.set $~lib/rt/itcms/pinSpace
  i32.const 368
  call $~lib/rt/itcms/initLazy
  global.set $~lib/rt/itcms/toSpace
  i32.const 512
  call $~lib/rt/itcms/initLazy
  global.set $~lib/rt/itcms/fromSpace
 )
 (func $~stack_check
  global.get $~lib/memory/__stack_pointer
  global.get $~lib/memory/__data_end
  i32.lt_s
  if
   i32.const 37648
   i32.const 37696
   i32.const 1
   i32.const 1
   call $~lib/builtins/abort
   unreachable
  end
 )
 (func $assembly/tensor_math/RNG#constructor (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  global.get $~lib/memory/__stack_pointer
  i32.const 8
  i32.sub
  global.set $~lib/memory/__stack_pointer
  call $~stack_check
  global.get $~lib/memory/__stack_pointer
  i64.const 0
  i64.store
  local.get $0
  i32.eqz
  if
   global.get $~lib/memory/__stack_pointer
   i32.const 4
   i32.const 4
   call $~lib/rt/itcms/__new
   local.tee $0
   i32.store
  end
  local.get $0
  local.set $2
  global.get $~lib/memory/__stack_pointer
  local.get $2
  i32.store offset=4
  local.get $2
  i32.const 0
  call $assembly/tensor_math/RNG#set:s
  local.get $0
  local.set $2
  global.get $~lib/memory/__stack_pointer
  local.get $2
  i32.store offset=4
  local.get $2
  local.get $1
  i32.const 0
  i32.eq
  if (result i32)
   i32.const -1640531527
  else
   local.get $1
  end
  call $assembly/tensor_math/RNG#set:s
  local.get $0
  local.set $2
  global.get $~lib/memory/__stack_pointer
  i32.const 8
  i32.add
  global.set $~lib/memory/__stack_pointer
  local.get $2
 )
 (func $~lib/staticarray/StaticArray<i32>#__get (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.sub
  global.set $~lib/memory/__stack_pointer
  call $~stack_check
  global.get $~lib/memory/__stack_pointer
  i32.const 0
  i32.store
  local.get $1
  local.get $0
  local.set $3
  global.get $~lib/memory/__stack_pointer
  local.get $3
  i32.store
  local.get $3
  call $~lib/staticarray/StaticArray<i32>#get:length
  i32.ge_u
  if
   i32.const 416
   i32.const 672
   i32.const 78
   i32.const 41
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  local.get $1
  i32.const 2
  i32.shl
  i32.add
  i32.load
  local.set $2
  i32.const 0
  drop
  local.get $2
  local.set $3
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.add
  global.set $~lib/memory/__stack_pointer
  local.get $3
  return
 )
 (func $~lib/staticarray/StaticArray<f64>#__get (param $0 i32) (param $1 i32) (result f64)
  (local $2 f64)
  (local $3 i32)
  (local $4 f64)
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.sub
  global.set $~lib/memory/__stack_pointer
  call $~stack_check
  global.get $~lib/memory/__stack_pointer
  i32.const 0
  i32.store
  local.get $1
  local.get $0
  local.set $3
  global.get $~lib/memory/__stack_pointer
  local.get $3
  i32.store
  local.get $3
  call $~lib/staticarray/StaticArray<f64>#get:length
  i32.ge_u
  if
   i32.const 416
   i32.const 672
   i32.const 78
   i32.const 41
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  local.get $1
  i32.const 3
  i32.shl
  i32.add
  f64.load
  local.set $2
  i32.const 0
  drop
  local.get $2
  local.set $4
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.add
  global.set $~lib/memory/__stack_pointer
  local.get $4
  return
 )
 (func $assembly/tensor_math/RNG#next (param $0 i32) (result f64)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 f64)
  global.get $~lib/memory/__stack_pointer
  i32.const 8
  i32.sub
  global.set $~lib/memory/__stack_pointer
  call $~stack_check
  global.get $~lib/memory/__stack_pointer
  i64.const 0
  i64.store
  local.get $0
  local.set $7
  global.get $~lib/memory/__stack_pointer
  local.get $7
  i32.store
  local.get $7
  local.get $0
  local.set $7
  global.get $~lib/memory/__stack_pointer
  local.get $7
  i32.store offset=4
  local.get $7
  call $assembly/tensor_math/RNG#get:s
  i32.const 1831565813
  i32.add
  call $assembly/tensor_math/RNG#set:s
  local.get $0
  local.set $7
  global.get $~lib/memory/__stack_pointer
  local.get $7
  i32.store
  local.get $7
  call $assembly/tensor_math/RNG#get:s
  local.get $0
  local.set $7
  global.get $~lib/memory/__stack_pointer
  local.get $7
  i32.store
  local.get $7
  call $assembly/tensor_math/RNG#get:s
  i32.const 15
  i32.shr_u
  i32.xor
  local.set $1
  i32.const 1
  local.get $0
  local.set $7
  global.get $~lib/memory/__stack_pointer
  local.get $7
  i32.store
  local.get $7
  call $assembly/tensor_math/RNG#get:s
  i32.or
  local.set $2
  local.get $1
  f64.convert_i32_s
  local.get $2
  f64.convert_i32_s
  call $~lib/math/NativeMath.imul
  i32.trunc_sat_f64_u
  local.set $3
  local.get $3
  local.get $3
  i32.const 7
  i32.shr_u
  i32.xor
  local.set $4
  i32.const 61
  local.get $3
  i32.or
  local.set $5
  local.get $3
  local.get $4
  f64.convert_i32_s
  local.get $5
  f64.convert_i32_s
  call $~lib/math/NativeMath.imul
  i32.trunc_sat_f64_u
  i32.xor
  local.set $3
  local.get $3
  local.get $3
  i32.const 14
  i32.shr_u
  i32.xor
  local.set $6
  local.get $6
  f64.convert_i32_u
  f64.const 4294967296
  f64.div
  local.set $8
  global.get $~lib/memory/__stack_pointer
  i32.const 8
  i32.add
  global.set $~lib/memory/__stack_pointer
  local.get $8
  return
 )
 (func $assembly/tensor_math/rolloutReward (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (result f64)
  (local $4 f64)
  (local $5 f64)
  (local $6 f64)
  (local $7 f64)
  (local $8 f64)
  (local $9 f64)
  (local $10 f64)
  (local $11 f64)
  (local $12 f64)
  (local $13 f64)
  (local $14 f64)
  (local $15 f64)
  (local $16 f64)
  (local $17 f64)
  (local $18 i32)
  (local $19 i32)
  (local $20 i32)
  (local $21 i32)
  (local $22 f64)
  (local $23 f64)
  (local $24 f64)
  (local $25 f64)
  (local $26 f64)
  (local $27 f64)
  (local $28 f64)
  (local $29 f64)
  (local $30 f64)
  (local $31 f64)
  (local $32 f64)
  (local $33 f64)
  (local $34 f64)
  (local $35 f64)
  (local $36 f64)
  (local $37 f64)
  (local $38 f64)
  (local $39 f64)
  (local $40 i32)
  (local $41 f64)
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.sub
  global.set $~lib/memory/__stack_pointer
  call $~stack_check
  global.get $~lib/memory/__stack_pointer
  i32.const 0
  i32.store
  local.get $0
  i32.const 0
  i32.const 8
  i32.mul
  i32.add
  f64.load
  local.set $4
  local.get $0
  i32.const 1
  i32.const 8
  i32.mul
  i32.add
  f64.load
  local.set $5
  local.get $0
  i32.const 2
  i32.const 8
  i32.mul
  i32.add
  f64.load
  local.set $6
  local.get $0
  i32.const 3
  i32.const 8
  i32.mul
  i32.add
  f64.load
  local.set $7
  local.get $0
  i32.const 4
  i32.const 8
  i32.mul
  i32.add
  f64.load
  local.set $8
  local.get $0
  i32.const 5
  i32.const 8
  i32.mul
  i32.add
  f64.load
  local.set $9
  local.get $0
  i32.const 6
  i32.const 8
  i32.mul
  i32.add
  f64.load
  local.set $10
  local.get $0
  i32.const 7
  i32.const 8
  i32.mul
  i32.add
  f64.load
  local.set $11
  local.get $0
  i32.const 8
  i32.const 8
  i32.mul
  i32.add
  f64.load
  local.set $12
  local.get $0
  i32.const 9
  i32.const 8
  i32.mul
  i32.add
  f64.load
  local.set $13
  local.get $4
  f64.const 0.5
  f64.sub
  f64.const 1.9
  f64.mul
  local.get $6
  f64.const 0.5
  f64.mul
  f64.add
  local.get $7
  f64.const 0.3
  f64.mul
  f64.add
  local.set $14
  f64.const 0
  local.set $15
  block $~lib/math/NativeMath.max|inlined.0 (result f64)
   f64.const 2
   local.set $16
   local.get $3
   f64.convert_i32_s
   local.set $17
   local.get $16
   local.get $17
   f64.max
   br $~lib/math/NativeMath.max|inlined.0
  end
  i32.trunc_sat_f64_s
  local.set $18
  local.get $12
  f64.const 4
  f64.eq
  local.set $19
  local.get $12
  f64.const 3
  f64.eq
  local.set $20
  i32.const 0
  local.set $21
  loop $for-loop|0
   local.get $21
   local.get $18
   i32.lt_s
   if
    f64.const 0.12
    local.get $8
    f64.const 0.22
    f64.mul
    f64.add
    local.get $19
    if (result f64)
     f64.const 0.08
    else
     f64.const 0
    end
    f64.add
    local.set $22
    local.get $20
    if
     local.get $22
     f64.const 0.05
     f64.add
     local.set $22
    end
    local.get $2
    local.set $40
    global.get $~lib/memory/__stack_pointer
    local.get $40
    i32.store
    local.get $40
    call $assembly/tensor_math/RNG#next
    f64.const 0.5
    f64.sub
    f64.const 2
    f64.mul
    local.get $22
    f64.mul
    local.set $23
    local.get $15
    local.get $14
    f64.const 0.38
    f64.mul
    local.get $23
    f64.add
    f64.add
    local.set $15
    local.get $21
    i32.const 1
    i32.add
    local.set $21
    br $for-loop|0
   end
  end
  local.get $15
  local.get $18
  f64.convert_i32_s
  f64.div
  local.set $24
  local.get $10
  f64.const 0
  f64.ge
  if (result f64)
   f64.const 90
   local.get $10
   f64.sub
   f64.const 90
   f64.div
   f64.const 0
   f64.const 1
   call $assembly/tensor_math/clamp
  else
   f64.const 0.4
  end
  local.set $25
  local.get $8
  f64.const 0.4
  f64.mul
  local.get $11
  f64.const 1400
  f64.lt
  if (result f64)
   f64.const 0.25
  else
   f64.const 0
  end
  f64.add
  f64.const 0
  f64.const 1.3
  call $assembly/tensor_math/clamp
  local.set $26
  local.get $1
  i32.const 2
  i32.eq
  if
   f64.const 0.35
   local.get $25
   f64.mul
   f64.const 0.22
   local.get $26
   f64.mul
   f64.add
   local.get $20
   if (result f64)
    f64.const 0.18
   else
    f64.const 0
   end
   f64.add
   local.set $27
   block $~lib/math/NativeMath.abs|inlined.0 (result f64)
    local.get $24
    local.set $28
    local.get $28
    f64.abs
    br $~lib/math/NativeMath.abs|inlined.0
   end
   f64.const 0.45
   local.get $5
   f64.const 0.55
   f64.mul
   f64.add
   f64.mul
   local.set $29
   local.get $27
   local.get $29
   f64.sub
   f64.const -1.5
   f64.const 1.5
   call $assembly/tensor_math/clamp
   local.set $41
   global.get $~lib/memory/__stack_pointer
   i32.const 4
   i32.add
   global.set $~lib/memory/__stack_pointer
   local.get $41
   return
  end
  local.get $1
  i32.const 0
  i32.eq
  if (result f64)
   f64.const 1
  else
   f64.const -1
  end
  local.set $30
  local.get $30
  local.get $24
  f64.mul
  local.set $31
  local.get $5
  f64.const 0.3
  local.get $13
  f64.const 0.2
  f64.mul
  f64.add
  f64.mul
  local.set $32
  local.get $9
  f64.const 1.3
  f64.mul
  local.set $33
  local.get $30
  f64.const 1
  f64.eq
  if (result f64)
   f64.const 0.5
   local.get $4
   f64.sub
  else
   local.get $4
   f64.const 0.5
   f64.sub
  end
  local.set $34
  local.get $20
  if (result f64)
   f64.const 0.14
  else
   local.get $19
   if (result f64)
    f64.const 0.07
   else
    f64.const 0
   end
  end
  local.set $35
  block $~lib/math/NativeMath.max|inlined.1 (result f64)
   f64.const 0
   local.set $36
   local.get $34
   local.set $37
   local.get $36
   local.get $37
   f64.max
   br $~lib/math/NativeMath.max|inlined.1
  end
  local.set $38
  local.get $25
  f64.const 0.28
  f64.mul
  local.get $26
  f64.const 0.2
  f64.mul
  f64.add
  local.get $35
  f64.add
  local.get $38
  f64.add
  local.set $39
  local.get $31
  f64.const 1.2
  f64.mul
  local.get $32
  f64.add
  local.get $33
  f64.add
  local.get $39
  f64.sub
  f64.const -1.5
  f64.const 1.5
  call $assembly/tensor_math/clamp
  local.set $41
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.add
  global.set $~lib/memory/__stack_pointer
  local.get $41
  return
 )
 (func $~lib/staticarray/StaticArray<i32>#__set (param $0 i32) (param $1 i32) (param $2 i32)
  (local $3 i32)
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.sub
  global.set $~lib/memory/__stack_pointer
  call $~stack_check
  global.get $~lib/memory/__stack_pointer
  i32.const 0
  i32.store
  local.get $1
  local.get $0
  local.set $3
  global.get $~lib/memory/__stack_pointer
  local.get $3
  i32.store
  local.get $3
  call $~lib/staticarray/StaticArray<i32>#get:length
  i32.ge_u
  if
   i32.const 416
   i32.const 672
   i32.const 93
   i32.const 41
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  local.set $3
  global.get $~lib/memory/__stack_pointer
  local.get $3
  i32.store
  local.get $3
  local.get $1
  local.get $2
  call $~lib/staticarray/StaticArray<i32>#__uset
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.add
  global.set $~lib/memory/__stack_pointer
 )
 (func $~lib/staticarray/StaticArray<f64>#__set (param $0 i32) (param $1 i32) (param $2 f64)
  (local $3 i32)
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.sub
  global.set $~lib/memory/__stack_pointer
  call $~stack_check
  global.get $~lib/memory/__stack_pointer
  i32.const 0
  i32.store
  local.get $1
  local.get $0
  local.set $3
  global.get $~lib/memory/__stack_pointer
  local.get $3
  i32.store
  local.get $3
  call $~lib/staticarray/StaticArray<f64>#get:length
  i32.ge_u
  if
   i32.const 416
   i32.const 672
   i32.const 93
   i32.const 41
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  local.set $3
  global.get $~lib/memory/__stack_pointer
  local.get $3
  i32.store
  local.get $3
  local.get $1
  local.get $2
  call $~lib/staticarray/StaticArray<f64>#__uset
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.add
  global.set $~lib/memory/__stack_pointer
 )
 (func $assembly/tensor_math/runMcts (param $0 i32) (param $1 i32) (param $2 i32) (param $3 i32) (param $4 f64) (param $5 i32)
  (local $6 i32)
  (local $7 i32)
  (local $8 i32)
  (local $9 i32)
  (local $10 i32)
  (local $11 i32)
  (local $12 f64)
  (local $13 i32)
  (local $14 i32)
  (local $15 f64)
  (local $16 f64)
  (local $17 f64)
  (local $18 f64)
  (local $19 f64)
  (local $20 f64)
  (local $21 f64)
  (local $22 i32)
  global.get $~lib/memory/__stack_pointer
  i32.const 20
  i32.sub
  global.set $~lib/memory/__stack_pointer
  call $~stack_check
  global.get $~lib/memory/__stack_pointer
  i32.const 0
  i32.const 20
  memory.fill
  global.get $~lib/memory/__stack_pointer
  i32.const 0
  local.get $5
  call $assembly/tensor_math/RNG#constructor
  local.tee $6
  i32.store
  global.get $~lib/memory/__stack_pointer
  i32.const 0
  i32.const 3
  call $~lib/staticarray/StaticArray<i32>#constructor
  local.tee $7
  i32.store offset=4
  global.get $~lib/memory/__stack_pointer
  i32.const 0
  i32.const 3
  call $~lib/staticarray/StaticArray<f64>#constructor
  local.tee $8
  i32.store offset=8
  i32.const 0
  local.set $9
  i32.const 0
  local.set $10
  loop $for-loop|0
   local.get $10
   local.get $2
   i32.lt_s
   if
    i32.const 0
    local.set $11
    f64.const -1e6
    local.set $12
    i32.const 0
    local.set $13
    loop $for-loop|1
     local.get $13
     i32.const 3
     i32.lt_s
     if
      local.get $7
      local.set $22
      global.get $~lib/memory/__stack_pointer
      local.get $22
      i32.store offset=12
      local.get $22
      local.get $13
      call $~lib/staticarray/StaticArray<i32>#__get
      local.set $14
      local.get $8
      local.set $22
      global.get $~lib/memory/__stack_pointer
      local.get $22
      i32.store offset=12
      local.get $22
      local.get $13
      call $~lib/staticarray/StaticArray<f64>#__get
      local.set $15
      local.get $14
      i32.const 0
      i32.eq
      if (result f64)
       f64.const 1e6
      else
       local.get $15
       local.get $14
       f64.convert_i32_s
       f64.div
       local.get $4
       block $~lib/math/NativeMath.sqrt|inlined.0 (result f64)
        local.get $9
        i32.const 1
        i32.add
        f64.convert_i32_s
        call $~lib/math/NativeMath.log
        local.get $14
        f64.convert_i32_s
        f64.div
        local.set $16
        local.get $16
        f64.sqrt
        br $~lib/math/NativeMath.sqrt|inlined.0
       end
       f64.mul
       f64.add
      end
      local.set $17
      local.get $17
      local.get $12
      f64.gt
      if
       local.get $17
       local.set $12
       local.get $13
       local.set $11
      end
      local.get $13
      i32.const 1
      i32.add
      local.set $13
      br $for-loop|1
     end
    end
    local.get $0
    local.get $11
    local.get $6
    local.set $22
    global.get $~lib/memory/__stack_pointer
    local.get $22
    i32.store offset=12
    local.get $22
    local.get $3
    call $assembly/tensor_math/rolloutReward
    local.set $18
    local.get $7
    local.set $22
    global.get $~lib/memory/__stack_pointer
    local.get $22
    i32.store offset=12
    local.get $22
    local.get $11
    local.get $7
    local.set $22
    global.get $~lib/memory/__stack_pointer
    local.get $22
    i32.store offset=16
    local.get $22
    local.get $11
    call $~lib/staticarray/StaticArray<i32>#__get
    i32.const 1
    i32.add
    call $~lib/staticarray/StaticArray<i32>#__set
    local.get $8
    local.set $22
    global.get $~lib/memory/__stack_pointer
    local.get $22
    i32.store offset=12
    local.get $22
    local.get $11
    local.get $8
    local.set $22
    global.get $~lib/memory/__stack_pointer
    local.get $22
    i32.store offset=16
    local.get $22
    local.get $11
    call $~lib/staticarray/StaticArray<f64>#__get
    local.get $18
    f64.add
    call $~lib/staticarray/StaticArray<f64>#__set
    local.get $9
    i32.const 1
    i32.add
    local.set $9
    local.get $10
    i32.const 1
    i32.add
    local.set $10
    br $for-loop|0
   end
  end
  local.get $7
  local.set $22
  global.get $~lib/memory/__stack_pointer
  local.get $22
  i32.store offset=12
  local.get $22
  i32.const 0
  call $~lib/staticarray/StaticArray<i32>#__get
  i32.const 0
  i32.gt_s
  if (result f64)
   local.get $8
   local.set $22
   global.get $~lib/memory/__stack_pointer
   local.get $22
   i32.store offset=12
   local.get $22
   i32.const 0
   call $~lib/staticarray/StaticArray<f64>#__get
   local.get $7
   local.set $22
   global.get $~lib/memory/__stack_pointer
   local.get $22
   i32.store offset=12
   local.get $22
   i32.const 0
   call $~lib/staticarray/StaticArray<i32>#__get
   f64.convert_i32_s
   f64.div
  else
   f64.const 0
  end
  local.set $19
  local.get $7
  local.set $22
  global.get $~lib/memory/__stack_pointer
  local.get $22
  i32.store offset=12
  local.get $22
  i32.const 1
  call $~lib/staticarray/StaticArray<i32>#__get
  i32.const 0
  i32.gt_s
  if (result f64)
   local.get $8
   local.set $22
   global.get $~lib/memory/__stack_pointer
   local.get $22
   i32.store offset=12
   local.get $22
   i32.const 1
   call $~lib/staticarray/StaticArray<f64>#__get
   local.get $7
   local.set $22
   global.get $~lib/memory/__stack_pointer
   local.get $22
   i32.store offset=12
   local.get $22
   i32.const 1
   call $~lib/staticarray/StaticArray<i32>#__get
   f64.convert_i32_s
   f64.div
  else
   f64.const 0
  end
  local.set $20
  local.get $7
  local.set $22
  global.get $~lib/memory/__stack_pointer
  local.get $22
  i32.store offset=12
  local.get $22
  i32.const 2
  call $~lib/staticarray/StaticArray<i32>#__get
  i32.const 0
  i32.gt_s
  if (result f64)
   local.get $8
   local.set $22
   global.get $~lib/memory/__stack_pointer
   local.get $22
   i32.store offset=12
   local.get $22
   i32.const 2
   call $~lib/staticarray/StaticArray<f64>#__get
   local.get $7
   local.set $22
   global.get $~lib/memory/__stack_pointer
   local.get $22
   i32.store offset=12
   local.get $22
   i32.const 2
   call $~lib/staticarray/StaticArray<i32>#__get
   f64.convert_i32_s
   f64.div
  else
   f64.const 0
  end
  local.set $21
  local.get $1
  i32.const 0
  i32.const 8
  i32.mul
  i32.add
  local.get $19
  f64.store
  local.get $1
  i32.const 1
  i32.const 8
  i32.mul
  i32.add
  local.get $20
  f64.store
  local.get $1
  i32.const 2
  i32.const 8
  i32.mul
  i32.add
  local.get $21
  f64.store
  global.get $~lib/memory/__stack_pointer
  i32.const 20
  i32.add
  global.set $~lib/memory/__stack_pointer
 )
 (func $~lib/staticarray/StaticArray<i32>#constructor (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.sub
  global.set $~lib/memory/__stack_pointer
  call $~stack_check
  global.get $~lib/memory/__stack_pointer
  i32.const 0
  i32.store
  local.get $1
  i32.const 1073741820
  i32.const 2
  i32.shr_u
  i32.gt_u
  if
   i32.const 624
   i32.const 672
   i32.const 51
   i32.const 60
   call $~lib/builtins/abort
   unreachable
  end
  local.get $1
  i32.const 2
  i32.shl
  local.set $2
  global.get $~lib/memory/__stack_pointer
  local.get $2
  i32.const 5
  call $~lib/rt/itcms/__new
  local.tee $3
  i32.store
  i32.const 2
  global.get $~lib/shared/runtime/Runtime.Incremental
  i32.ne
  drop
  local.get $3
  local.set $4
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.add
  global.set $~lib/memory/__stack_pointer
  local.get $4
  return
 )
 (func $~lib/staticarray/StaticArray<f64>#constructor (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.sub
  global.set $~lib/memory/__stack_pointer
  call $~stack_check
  global.get $~lib/memory/__stack_pointer
  i32.const 0
  i32.store
  local.get $1
  i32.const 1073741820
  i32.const 3
  i32.shr_u
  i32.gt_u
  if
   i32.const 624
   i32.const 672
   i32.const 51
   i32.const 60
   call $~lib/builtins/abort
   unreachable
  end
  local.get $1
  i32.const 3
  i32.shl
  local.set $2
  global.get $~lib/memory/__stack_pointer
  local.get $2
  i32.const 6
  call $~lib/rt/itcms/__new
  local.tee $3
  i32.store
  i32.const 2
  global.get $~lib/shared/runtime/Runtime.Incremental
  i32.ne
  drop
  local.get $3
  local.set $4
  global.get $~lib/memory/__stack_pointer
  i32.const 4
  i32.add
  global.set $~lib/memory/__stack_pointer
  local.get $4
  return
 )
)
