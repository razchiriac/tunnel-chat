const A = ['brisk','calm','cosmic','dapper','eager','groovy','mellow','nimble','plucky','quirky','snug','spry','zesty'];
const B = ['apple','bread','cloud','ember','falcon','maple','meadow','pepper','pixel','rocket','saffron','thunder','voyage'];
const C = ['king','queen','rider','scout','smith','sage','pilot','keeper','oracle','weaver','ranger','scribe','tinker'];

export function autoName(): string {
  const r = (n: number) => Math.floor(Math.random() * n);
  return `${A[r(A.length)]}-${B[r(B.length)]}-${C[r(C.length)]}`;
}
