use tonic::{Request, Response, Status};
use tracing::info;

use crate::supervisor;
use crate::tokenizer;
use crate::vector;
use crate::zome::zome_sidecar_server::{ZomeSidecar, ZomeSidecarServer};
use crate::zome::{
    DeleteAgentRequest, DeleteAgentResponse, HealthRequest, HealthResponse, SearchRequest,
    SearchResponse, SearchResult, TokenCountRequest, TokenCountResponse, UpsertRequest,
    UpsertResponse,
};

#[derive(Default)]
pub struct ZomeSidecarService;

#[tonic::async_trait]
impl ZomeSidecar for ZomeSidecarService {
    async fn upsert(
        &self,
        request: Request<UpsertRequest>,
    ) -> Result<Response<UpsertResponse>, Status> {
        let req = request.into_inner();
        let agent_id = crate::sanitize_agent_id(&req.agent_id)
            .map_err(|e| Status::invalid_argument(e.to_string()))?;
        // 维度校验（H10b）：空向量非法——原实现空首插会把 0 维写进索引，
        // 维度永远钉不住且距离求值 panic
        if req.embedding.is_empty() {
            return Err(Status::invalid_argument("embedding must not be empty"));
        }
        let state = vector::get_or_load(&agent_id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        let mut guard = state.write().await;
        // 首个非空写入钉住索引维度（dim==0 = 空索引未定维）；此后异维写入
        // 显式报错（含期望/实际维度），不再静默吞掉
        let dim = guard.dim();
        if dim != 0 && req.embedding.len() != dim {
            return Err(Status::invalid_argument(format!(
                "embedding dim mismatch: index dim is {dim}, got {}",
                req.embedding.len()
            )));
        }
        guard.upsert(&req.doc_id, &req.embedding).await;
        Ok(Response::new(UpsertResponse {}))
    }

    async fn search(
        &self,
        request: Request<SearchRequest>,
    ) -> Result<Response<SearchResponse>, Status> {
        let req = request.into_inner();
        let agent_id = crate::sanitize_agent_id(&req.agent_id)
            .map_err(|e| Status::invalid_argument(e.to_string()))?;
        let state = vector::get_or_load(&agent_id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        let guard = state.read().await;
        // 维度校验（H10b）：查询与索引维度不一致显式报错——原实现静默返回空，
        // 调用方无法区分"无相似结果"与"维度用错"。空索引（dim==0 未定维）
        // 不校验，检索恒返回空
        let dim = guard.dim();
        if dim != 0 && req.query.len() != dim {
            return Err(Status::invalid_argument(format!(
                "query dim mismatch: index dim is {dim}, got {}",
                req.query.len()
            )));
        }
        let results = guard
            .search(&req.query, req.top_k as usize)
            .into_iter()
            .map(|(doc_id, score)| SearchResult { doc_id, score })
            .collect();
        Ok(Response::new(SearchResponse { results }))
    }

    async fn count_tokens(
        &self,
        request: Request<TokenCountRequest>,
    ) -> Result<Response<TokenCountResponse>, Status> {
        let req = request.into_inner();
        let count = tokenizer::count_tokens(&req.text, &req.model);
        Ok(Response::new(TokenCountResponse { count }))
    }

    async fn delete_agent(
        &self,
        request: Request<DeleteAgentRequest>,
    ) -> Result<Response<DeleteAgentResponse>, Status> {
        let req = request.into_inner();
        let agent_id = crate::sanitize_agent_id(&req.agent_id)
            .map_err(|e| Status::invalid_argument(e.to_string()))?;
        vector::delete_agent(&agent_id)
            .await
            .map_err(|e| Status::internal(e.to_string()))?;
        Ok(Response::new(DeleteAgentResponse {}))
    }

    async fn health(
        &self,
        _request: Request<HealthRequest>,
    ) -> Result<Response<HealthResponse>, Status> {
        let status = if supervisor::is_node_healthy().await {
            "ok"
        } else {
            "degraded"
        }
        .to_string();
        Ok(Response::new(HealthResponse { status }))
    }
}

pub async fn serve() -> anyhow::Result<()> {
    // 权威定义在 packages/shared/src/constants.ts（DEFAULT_SIDECAR_ADDR，P5-2），人工对齐
    let addr = "127.0.0.1:50051".parse()?;
    info!("gRPC listening on {}", addr);

    tonic::transport::Server::builder()
        .add_service(ZomeSidecarServer::new(ZomeSidecarService))
        .serve(addr)
        .await?;

    Ok(())
}
